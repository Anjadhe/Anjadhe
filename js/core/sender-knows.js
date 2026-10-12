/**
 * SenderKnows — everything nenva knows about one sender, read in ONE place
 * (docs/SENDERS.md M8, 2026-10-10).
 *
 * Before: what nenva knew about a thing was spread over stores that each
 * page read on its own — Decisions (per record, `agent-decisions`),
 * Updates (per commitment, `updates`), what the person told it (M5,
 * `sender.facts`), the sender look's notebook (`sender-looks`), routines
 * (Standing chats), documents (the library) and jobs (TeamJobs). A thing's
 * info page, `get_sender`, the reply in its thread and its look each saw a
 * different part.
 *
 * Now ONE reader joins them per sender. The records stay in their own
 * stores and keep their own laws (a decision is an instruction, an update
 * is history, a fact is the person's words); nothing is copied or moved,
 * so nothing synced is rewritten. What a sender adds is LINKS
 * (`Senders.link`) to a document or a routine that is about it.
 *
 *   told        what the person told nenva about it (M5)
 *   decisions   standing instructions on its items, newest first, each
 *               saying which item it is on (READ AS INSTRUCTIONS)
 *   updates     the dated log on its items (history, never instructions)
 *   watching    the sender look's notes and its look-again day
 *   routines    linked routines, each with its latest news
 *   documents   linked documents (title, id)
 *   accounts    linked money accounts (`portfolio:<id>` / `spending:<id>`, title)
 *   jobs        jobs started in its thread (or its items' chats), with status
 *
 * Pure core (tests/sender-knows-test.js): gather, lines.
 */
const SenderKnows = {
    MAX: { told: 15, decisions: 8, updates: 6, watching: 4, routines: 6, documents: 12, jobs: 4 },

    _clean(v, n) { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; },

    /**
     * Join what the stores hold. Pure: every reader is passed in.
     * src: { sender, members: [{ key, title }], decisionsOf(key) -> [{ title, body, createdAt }],
     *        updatesOf(key) -> [{ body, createdAt, source }], notebook: { notes, lookAgain },
     *        routineOf(id) -> { title, last: { at, line } } | null, jobs: [{ id, status, goal, note }] }
     */
    gather(src) {
        const s = src.sender || {};
        const M = this.MAX;
        const decisions = [], updates = [];
        for (const m of src.members || []) {
            for (const d of (src.decisionsOf ? src.decisionsOf(m.key) : []) || []) decisions.push({ on: m.title, key: m.key, title: d.title || '', text: this._clean(d.body || d.title, 300), at: d.createdAt || '' });
            for (const u of (src.updatesOf ? src.updatesOf(m.key) : []) || []) updates.push({ on: m.title, key: m.key, text: this._clean(u.body, 240), at: u.createdAt || '', by: u.source === 'ai' ? 'nenva' : 'you' });
        }
        const byAt = (a, b) => String(b.at).localeCompare(String(a.at));
        const links = Array.isArray(s.links) ? s.links : [];
        const routines = links.filter(l => l.kind === 'routine').map(l => {
            const r = src.routineOf ? src.routineOf(l.ref) : null;
            return r ? { id: l.ref, title: r.title || l.title, last: r.last || null } : null;
        }).filter(Boolean);
        const nb = src.notebook || {};
        return {
            told: (s.facts || []).slice(-M.told).reverse().map(f => ({ id: f.id, text: f.text, at: f.at })),
            decisions: decisions.sort(byAt).slice(0, M.decisions),
            updates: updates.sort(byAt).slice(0, M.updates),
            watching: { notes: (nb.notes || []).slice(-M.watching).reverse().map(n => ({ text: n.text, at: n.at })), lookAgain: nb.lookAgain || null },
            routines: routines.slice(0, M.routines),
            documents: links.filter(l => l.kind === 'doc').slice(-M.documents).reverse().map(l => ({ id: l.ref, title: l.title || 'Document' })),
            accounts: links.filter(l => l.kind === 'account').map(l => ({ id: l.ref, title: l.title || 'Account' })),
            jobs: (src.jobs || []).slice(0, M.jobs).map(j => ({ id: j.id, status: j.status, goal: this._clean(j.goal, 120), note: this._clean(j.note, 120) }))
        };
    },

    /** The same, as plain lines for a prompt (the reply in its thread, its look). Pure. */
    lines(k) {
        const out = [];
        if (k.decisions.length) { out.push('Standing decisions on it (follow these):'); for (const d of k.decisions) out.push(`- on "${d.on}": ${d.text}`); }
        if (k.updates.length) { out.push('Latest updates (history):'); for (const u of k.updates) out.push(`- ${String(u.at).slice(0, 10)} on "${u.on}" (${u.by}): ${u.text}`); }
        if (k.routines.length) { out.push('Routines about it:'); for (const r of k.routines) out.push(`- "${r.title}"${r.last ? `, last: ${String(r.last.at || '').slice(0, 10)} ${r.last.line}` : ''}`); }
        if (k.documents.length) out.push(`Documents attached to it (read with read_library_doc): ${k.documents.map(d => `"${d.title}" (id ${d.id})`).join(', ')}`);
        if ((k.accounts || []).length) out.push(`Money accounts attached to it (its figures are in the thread's drawer; read them with get_thread_panel, list_portfolio or spending_summary): ${k.accounts.map(a => `"${a.title}" (${a.id})`).join(', ')}`);
        if (k.jobs.length) { out.push('Jobs for it:'); for (const j of k.jobs) out.push(`- ${j.status}: ${j.goal}${j.note ? ` (${j.note})` : ''}`); }
        return out;
    },

    // ── Runtime ─────────────────────────────────────────────────────────

    /** The decision and update keys of one item (a commitment is a task or, for a project, a goal). */
    _keysOf(key) {
        if (/^task:/.test(key)) { const id = key.slice(5); return [`task:${id}`, `goal:${id}`]; }
        return [key];
    },
    _routine(id) {
        if (typeof NotePrompts === 'undefined') return null;
        const r = NotePrompts.get ? NotePrompts.get(id) : null;
        if (!r) return null;
        const run = (NotePrompts.runs ? NotePrompts.runs(id) : []).find(x => !x.error);
        const line = run ? this._clean((run.look && run.look.headline) || String(run.content || '').split('\n').find(l => l.trim()) || '', 160) : '';
        return { title: r.title, last: run ? { at: run.createdAt, line } : null };
    },
    _jobs(id) {
        if (typeof TeamJobs === 'undefined' || typeof ThreadsPage === 'undefined') return [];
        try {
            const convs = new Set(ThreadsPage.convsOf(id).map(c => c.id));
            const routines = new Set(Senders.linksOf(id, 'routine').map(l => l.ref));
            return TeamJobs.all().filter(j => (j.conversationId && convs.has(j.conversationId)) || (j.routineId && routines.has(j.routineId)))
                .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
        } catch { return []; }
    },
    /** Everything nenva knows about one sender. */
    of(id) {
        if (typeof Senders === 'undefined') return null;
        const s = Senders.get(id);
        if (!s || s.builtIn) return null;
        const title = key => {
            if (/^matter:/.test(key) && typeof Matters !== 'undefined') { const m = Matters.get(key); return m ? Matters.titleOf(m) : key; }
            const c = typeof Commitments !== 'undefined' ? Commitments.get(key.slice(5)) : null;
            return c ? c.title : key;
        };
        const members = Senders.members(s.id).map(key => ({ key, title: title(key) }));
        const nbAll = typeof SenderLook !== 'undefined' ? SenderLook.state().senders || {} : {};
        return this.gather({
            sender: s, members,
            decisionsOf: key => typeof DecisionStore !== 'undefined' ? this._keysOf(key).flatMap(k => DecisionStore.listFor(k)) : [],
            updatesOf: key => typeof UpdateStore !== 'undefined' ? this._keysOf(key).flatMap(k => UpdateStore.listFor(k, { limit: 6 })) : [],
            notebook: nbAll[s.id] || {},
            routineOf: rid => this._routine(rid),
            jobs: this._jobs(s.id)
        });
    }
};

if (typeof module !== 'undefined') module.exports = SenderKnows;
