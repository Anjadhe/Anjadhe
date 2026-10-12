/**
 * TaughtTasks — tasks the person taught nenva by SHOWING them once
 * (2026-10-07, docs/TEACH.md).
 *
 * "Let me show you how I get the kids' assignments." nenva opens its own
 * Chrome window, the person does the task the way they always do, the
 * extension notes what they did BY LABEL (what was clicked, chosen, typed;
 * which pages; which files landed), and the assistant writes that up as a
 * PLAYBOOK in words, which the person reads and corrects before it is kept.
 * From then on the task can be asked for in a chat ("get the Schoology
 * assignments") or armed as a routine, and the Browser agent re-performs it
 * with judgment, the playbook in its brief, pausing for the person at a
 * sign-in or anything else only they can do.
 *
 * This is not a macro recorder. A taught task is a note the agent reads,
 * never a script that is replayed click by click: a site that moved a link
 * is met with a fresh look, and a note the agent cannot follow becomes a
 * question, not a silent failure.
 *
 * Laws:
 *   T1 The recording is semantic and the person's. Labels, pages, file
 *      names; never coordinates or keystrokes. A field only the person may
 *      fill (MANUAL_FIELDS: passwords, codes, cards) is noted as filled
 *      with NO value. The raw log is shown to the assistant once, for the
 *      write-up, and is not stored.
 *   T2 The person confirms the words. A playbook is saved only through an
 *      ask whose dialog shows the whole note; they can edit it afterwards on
 *      Settings › Memory › Taught tasks, where it reads as plain text.
 *   T3 Code keeps the facts. The sites a playbook applies to are the hosts
 *      the recording visited (the assistant may narrow, never add); the
 *      title is short; the note has a cap. The write-up itself is the
 *      assistant's, and the person's to change.
 *   T4 A taught task reaches the agent as a Playbook (specialists/
 *      playbooks.js): by title in the brief, by host on the first look.
 *      Nothing else branches on it. Replay runs on the ordinary job engine
 *      with the ordinary approvals: signing in, paying and sending still
 *      ask every time, and a sign-in wall still hands over to the person.
 *   T5 Everything stays on this Mac. Nothing about a recording or a
 *      playbook is sent anywhere unless the person shares the text.
 *
 *   T6 With teach off, stored tasks remain untouched and inactive.
 *
 * Pure parts (transcript, hostsOf, vet, toPlaybook) are Node-testable:
 * tests/taught-tasks-test.js. The store half needs StorageManager.
 */
const TaughtTasks = {
    STORE_KEY: 'taught-tasks',
    MAX_TITLE: 60,
    MAX_NOTE: 2400,
    MAX_ITEMS: 60,
    _items: null,

    enabled() { return typeof FEATURES !== 'undefined' && FEATURES.isEnabled('teach'); },

    /** Load once and hand every taught task to Playbooks when released. */
    init() {
        if (!this.enabled() || this._items) return;
        this._items = this._load();
        for (const item of this._items) this._register(item);
    },
    _load() {
        let data = null;
        try { data = typeof StorageManager !== 'undefined' ? StorageManager.get(this.STORE_KEY) : null; } catch { data = null; }
        const items = Array.isArray(data?.items) ? data.items : [];
        return items.filter(item => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.note === 'string');
    },
    _save() {
        try { if (typeof StorageManager !== 'undefined') StorageManager.set(this.STORE_KEY, { version: 1, items: this._items }); }
        catch (error) { console.warn('[taught-tasks] save failed:', error); }
    },
    all() { if (!this.enabled()) return []; this.init(); return this._items.map(item => ({ ...item })); },
    get(id) { if (!this.enabled()) return null; this.init(); return this._items.find(item => item.id === id) || null; },

    /** The hosts a recording visited, most visited first. Facts for T3. */
    hostsOf(log) {
        const counts = new Map();
        for (const event of log?.events || []) {
            if (event.type !== 'page' || !event.url) continue;
            let host; try { host = new URL(event.url).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
            if (host) counts.set(host, (counts.get(host) || 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([host]) => host);
    },

    /**
     * The recording as the assistant reads it: one numbered line per thing
     * the person did, grouped under the page it happened on. Nothing here is
     * model-written; a line says exactly what the extension saw.
     */
    transcript(log) {
        const events = Array.isArray(log?.events) ? log.events : [];
        const q = value => `“${String(value || '').replace(/\s+/g, ' ').trim()}”`;
        const where = event => event.near ? ` (under ${q(event.near)})` : '';
        const site = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
        const lines = []; let n = 0, lastKey = null;
        for (const event of events) {
            if (event.type === 'page') {
                const title = event.title ? ` — ${q(event.title)}` : '';
                lines.push(`On ${site(event.url)}${title}: ${String(event.url).slice(0, 160)}`);
                lastKey = null; continue;
            }
            let line;
            switch (event.type) {
                case 'click': line = `Clicked ${event.label ? q(event.label) : `a ${event.role || 'control'}`}${where(event)}${event.href ? ` → ${String(event.href).replace(/^https?:\/\/(www\.)?/, '')}` : ''}`; break;
                case 'type': line = event.secure ? `Filled in ${q(event.label || 'a sign-in field')} (only you can fill this; it was not recorded)` : `Typed ${q(event.value)} into ${q(event.label || 'a field')}${where(event)}`; break;
                case 'choose': line = `Chose ${q(event.value)} in ${q(event.label || 'a dropdown')}${where(event)}`; break;
                case 'toggle': line = `${event.checked ? 'Ticked' : 'Unticked'} ${q(event.label || 'a box')}${where(event)}`; break;
                case 'press': line = `Pressed ${event.key || 'Enter'}${event.label ? ` in ${q(event.label)}` : ''}`; break;
                case 'file': line = `Attached a file in ${q(event.label || 'a file field')}`; break;
                case 'download': line = `A file was downloaded: ${event.name}`; break;
                default: continue;
            }
            const key = JSON.stringify([event.type, event.label, event.value, event.href, event.checked]);
            if (key === lastKey) continue;   // a double click is one click
            lastKey = key;
            lines.push(`  ${++n}. ${line}`);
        }
        if (log?.full) lines.push('  (the recording reached its limit; later steps were not kept)');
        return lines.join('\n');
    },

    /**
     * Check what the assistant proposes against the facts (T3). `log` is the
     * recording it came from, when there is one: hosts outside it are dropped.
     * Returns { ok, item } or { error }.
     */
    vet(input, { log = null, existing = null } = {}) {
        const title = String(input?.title || '').replace(/\s+/g, ' ').trim();
        if (!title) return { error: 'A taught task needs a short title the user would say, like “Schoology check”.' };
        if (title.length > this.MAX_TITLE) return { error: `Keep the title under ${this.MAX_TITLE} characters.` };
        const note = String(input?.note || '').trim();
        if (!note) return { error: 'A taught task needs the note: what you learned, in words the Browser agent can follow.' };
        if (note.length > this.MAX_NOTE) return { error: `Keep the note under ${this.MAX_NOTE} characters: ${note.length} is too long. Say where things are and what the finished run looks like; leave out what the agent can see for itself.` };
        const recorded = log ? this.hostsOf(log) : (existing?.hosts || []);
        const asked = Array.isArray(input?.hosts) ? input.hosts.map(h => String(h || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim()).filter(Boolean) : [];
        let hosts = recorded.length ? asked.filter(host => recorded.some(seen => seen === host || seen.endsWith('.' + host))) : asked;
        if (!hosts.length) hosts = recorded;
        if (!hosts.length) return { error: 'No website was recorded. Start a recording and open the site first.' };
        const now = new Date().toISOString();
        const item = { ...(existing || {}), id: existing?.id || `tt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
            title, note, hosts: [...new Set(hosts)].slice(0, 8), taughtAt: existing?.taughtAt || now, updatedAt: now,
            steps: log ? (log.events || []).filter(e => e.type !== 'page').length : (existing?.steps || 0) };
        return { ok: true, item };
    },

    /** Save a vetted item (new or edited); registers it with Playbooks. */
    save(item) {
        if (!this.enabled()) throw new Error('Taught tasks are not enabled.');
        this.init();
        const at = this._items.findIndex(other => other.id === item.id);
        if (at === -1 && this._items.length >= this.MAX_ITEMS) throw new Error(`Only ${this.MAX_ITEMS} taught tasks can be kept. Remove one first.`);
        if (at === -1) this._items.unshift(item); else this._items[at] = item;
        this._save();
        this._register(item);
        return item;
    },
    /** The person edits the note in place (T2): the words change, the facts stay. */
    updateNote(id, note) {
        const existing = this.get(id);
        if (!existing) return { error: 'No such taught task.' };
        const check = this.vet({ title: existing.title, note, hosts: existing.hosts }, { existing });
        if (check.error) return check;
        return { ok: true, item: this.save(check.item) };
    },
    remove(id) {
        if (!this.enabled()) return null;
        this.init();
        const item = this._items.find(other => other.id === id);
        if (!item) return null;
        this._items = this._items.filter(other => other.id !== id);
        this._save();
        this._unregister(id);
        return item;
    },
    /** A run happened (TeamJobs tells us): kept for the page, never a judgment. */
    noteRun(id, outcome) {
        const item = this.get(id);
        if (!item) return;
        item.lastRun = { at: new Date().toISOString(), outcome: String(outcome || '').slice(0, 20) };
        item.runs = (item.runs || 0) + 1;
        this._save();
    },

    /** How a taught task reaches the Browser agent (T4): a playbook by title and by host. */
    toPlaybook(item) {
        const words = item.title.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
        const escaped = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\W+');
        const when = item.taughtAt ? new Date(item.taughtAt).toLocaleDateString() : '';
        return { id: `taught:${item.id}`, taught: true, hosts: item.hosts, task: new RegExp(escaped, 'i'),
            note: `Taught task “${item.title}”${when ? ` (the user showed you this on ${when})` : ''}, on ${item.hosts.join(', ')}. Follow it with judgment, not word for word; if the site no longer matches, look for the same thing under another name before giving up, and report what changed. ${item.note}` };
    },
    _register(item) {
        if (!this.enabled() || typeof Playbooks === 'undefined') return;
        try { Playbooks.register(this.toPlaybook(item)); } catch (error) { console.warn('[taught-tasks] playbook not registered:', error.message); }
    },
    _unregister(id) { if (typeof Playbooks !== 'undefined') Playbooks.unregister(`taught:${id}`); },

    /** What the job master is told: the tasks it can hand to Browser by name. */
    rosterLine() {
        const items = this.all();
        if (!items.length) return '';
        return 'Tasks the user TAUGHT you by showing them once (hand one to browser, naming the task by its exact title in the brief; Browser gets the notes):\n'
            + items.map(item => `- “${item.title}” on ${item.hosts.join(', ')}`).join('\n');
    }
};
if (typeof module !== 'undefined') module.exports = TaughtTasks;
