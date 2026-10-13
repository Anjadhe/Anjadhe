/**
 * sim-sources.js — simulated mail and texts for a TEST instance
 * ================================================================
 * Ram, 2026-10-12: "for simulating emails and text messages create a test
 * layer in between to simulate those without changing the code path, so
 * that for the test new emails and text messages can be simulated well."
 *
 * The layer sits where the outside world enters nenva, not inside nenva:
 *
 *   texts  Messages.app's chat.db is read by js/main/imessage-reader.js
 *          through ONE IPC, `imessage-read`. In sim mode that IPC is
 *          answered from this module's queue instead, with rows in exactly
 *          the reader's shape (rowid, guid, text, at, fromMe, handle, chat…),
 *          so the renderer's IMessageSource folds, builds records, files and
 *          raises exactly as it does for real texts. `imessage-probe`
 *          answers ok so the switch can be on without Full Disk Access.
 *   mail   Gmail's messages reach the renderer as the records main's
 *          fetchers build (messageId, from, subject, date, labels, bodyText…)
 *          and EmailApp.receiveEmails merges, persists, notifies routines
 *          and queues analysis. In sim mode this module pushes the same
 *          records to the window (`sim-mail-arrived`) and the renderer's
 *          SimSources hands them to that same function.
 *
 * Laws:
 *   SS1 Never on a real install. Active only when BOTH ANJADHE_DATA_ROOT and
 *       ANJADHE_SIM=1 are set; otherwise every call is a no-op and the real
 *       reader answers. A simulated record carries no mark the app reads
 *       (it IS a message to the app); the only mark is the test root.
 *   SS2 The app's path is unchanged. Nothing here calls the filer, the
 *       look, a store or a model; it answers the two boundaries above and
 *       nothing else. A new source needs its own boundary, never a second
 *       door into the engine.
 *   SS3 Time is the scenario's. A step's `at` is relative to "now" ("-2d
 *       08:12", "+21d", "0d 16:48") so a scenario is always current; the
 *       record's dates are what the real source would have carried.
 *   SS4 A scenario is a file (scripts/sim-scenarios/<name>.json), read by
 *       this module to play live, by the seed to plant its past, and by
 *       the Node evals to build fixtures: one source of truth per story.
 *
 * Pure parts (parseAt, mailRecord, textRow, Queue) are Node-exported and
 * pinned by tests/sim-sources-test.js.
 */
const fs = require('fs');
const path = require('path');

const SIM_ACCOUNT = 'emily@demo.anjadhe.local';
const SIM_NAME = 'Emily Carter';

/**
 * "-2d 08:12" | "+21d" | "0d 16:48" | "-182d" | an ISO string → a Date.
 * Days are calendar days from `now`'s date; a missing clock keeps 09:00.
 * A weekday anchor keeps a story's days of the week true on any day:
 * "thu+1" is the first Thursday at least 1 day from today, "thu+1+4 09:00"
 * four days after that (the Monday), "tue+6-3" three days before that
 * Tuesday.
 */
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function parseAt(at, now = new Date()) {
    if (at instanceof Date) return new Date(at);
    const s = String(at == null ? '' : at).trim();
    const clock = (d, h, mi) => { d.setHours(h != null ? Number(h) : 9, mi != null ? Number(mi) : 0, 0, 0); return d; };
    const w = s.match(/^(sun|mon|tue|wed|thu|fri|sat)\+(\d+)(?:([+-]\d+))?(?:\s+(\d{1,2}):(\d{2}))?$/i);
    if (w) {
        const d = new Date(now);
        d.setDate(d.getDate() + Number(w[2]));
        while (d.getDay() !== DOW[w[1].toLowerCase()]) d.setDate(d.getDate() + 1);
        if (w[3]) d.setDate(d.getDate() + Number(w[3]));
        return clock(d, w[4], w[5]);
    }
    const m = s.match(/^([+-]?\d+)d(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (!m) { const d = new Date(s); return isNaN(d.getTime()) ? new Date(now) : d; }
    const d = new Date(now);
    d.setDate(d.getDate() + Number(m[1]));
    return clock(d, m[2], m[3]);
}

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

/**
 * Dates inside a message's words, so a scenario reads right on any day
 * (SS3): "{{md:+21d}}" → "Nov 2", "{{dmd:+21d}}" → "Mon, Nov 2",
 * "{{dow:+21d}}" → "Monday", "{{long:+21d}}" → "Monday, November 2",
 * "{{nth:+21d}}" → "2nd", "{{iso:+21d}}" → "2026-11-02",
 * "{{clock:+21d 09:30}}" → "9:30 AM".
 */
const FORMATS = {
    md: d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    dmd: d => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
    dow: d => d.toLocaleDateString('en-US', { weekday: 'long' }),
    long: d => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    nth: d => { const n = d.getDate(); const s = (n % 10 === 1 && n !== 11) ? 'st' : (n % 10 === 2 && n !== 12) ? 'nd' : (n % 10 === 3 && n !== 13) ? 'rd' : 'th'; return n + s; },
    iso: d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    clock: d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
};
function fill(text, now = new Date()) {
    return String(text == null ? '' : text).replace(/\{\{(md|dmd|dow|long|nth|iso|clock):([^}]+)\}\}/g, (_, f, at) => FORMATS[f](parseAt(at.trim(), now)));
}

/** A Gmail message as main's fetchers hand it to the renderer. */
function mailRecord(step, now = new Date()) {
    const d = parseAt(step.at, now);
    step = { ...step, subject: fill(step.subject, now), body: fill(step.body, now), snippet: step.snippet ? fill(step.snippet, now) : step.snippet };
    const id = step.id || `sim-${slug(step.subject)}-${d.getTime()}`;
    const labels = step.sent ? ['SENT'] : ['INBOX'];
    if (!step.sent && !step.read) labels.push('UNREAD');
    if (step.important) labels.push('IMPORTANT');
    if (step.category) labels.push(step.category);
    const body = String(step.body || '');
    const html = step.bodyHtml || body.split('\n\n').map(p => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('');
    const account = step.account || SIM_ACCOUNT;
    return {
        messageId: id,
        threadId: step.threadId || `${id}-thr`,
        account,
        from: step.sent ? `${SIM_NAME} <${account}>` : String(step.from || ''),
        to: step.sent ? String(step.to || '') : `${SIM_NAME} <${account}>`,
        cc: '',
        subject: String(step.subject || ''),
        date: d.toUTCString(),
        messageIdHeader: `<${id}@demo.anjadhe.local>`,
        snippet: step.snippet || body.replace(/\s+/g, ' ').trim().slice(0, 140),
        labels,
        isRead: !!(step.read || step.sent),
        isStarred: false,
        internalDate: String(d.getTime()),
        attachments: Array.isArray(step.attachments) ? step.attachments : [],
        bodyText: body,
        bodyHtml: html
    };
}

/** One row as imessage-reader's readSince returns it. `rowid` is the queue's. */
function textRow(step, rowid, now = new Date()) {
    const d = parseAt(step.at, now);
    const handle = String(step.handle || '');
    return {
        rowid,
        guid: step.guid || `sim-${rowid}-${d.getTime()}`,
        text: fill(step.text, now),
        at: d.toISOString(),
        fromMe: !!step.fromMe,
        handle,
        hasAttachment: false,
        service: step.service || 'SMS',
        chatId: Number(step.chatId) || (handle ? Math.abs(hash(handle)) : rowid),
        chatGuid: step.chatGuid || `${step.service || 'SMS'};-;${handle}`,
        chatIdentifier: step.chatIdentifier || handle,
        chatName: step.chatName || '',
        isGroup: !!step.isGroup
    };
}
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

/** The text queue: rows answer readSince like chat.db would. */
class Queue {
    constructor() { this.rows = []; this.next = 1; }
    push(step, now) { const row = textRow(step, this.next++, now); this.rows.push(row); return row; }
    readSince({ afterRowid = 0, limit = 500 } = {}) {
        const rows = this.rows.filter(r => r.rowid > Number(afterRowid || 0)).slice(0, limit);
        const maxRowid = rows.length ? rows[rows.length - 1].rowid : Number(afterRowid || 0);
        return { ok: true, rows, maxRowid, more: false };
    }
}

function createSimSources({ dataRoot, enabled, reader, send, scenariosDir }) {
    const active = !!(dataRoot && enabled);   // SS1
    const texts = new Queue();
    const log = [];
    const note = (kind, what) => { log.push({ at: new Date().toISOString(), kind, what }); if (log.length > 500) log.shift(); };

    const loadScenario = (name) => {
        const safe = String(name || '').replace(/[^a-z0-9_-]/gi, '');
        const file = path.join(scenariosDir, `${safe}.json`);
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    };

    const api = {
        active,
        status() { return { active, texts: texts.rows.length, log: log.slice(-20) }; },
        /** The reader the IPC handlers call: the queue in sim mode, chat.db otherwise. */
        reader: {
            readSince: (opts) => active ? texts.readSince(opts || {}) : reader.readSince(opts || {}),
            probe: () => active ? { ok: true, reason: 'sim', error: '' } : reader.probe()
        },
        /** One record arrives now (or at its own `at`). Returns what was built. */
        arrive(step) {
            if (!active) return { ok: false, error: 'not a test instance' };
            const kind = step && step.kind;
            if (kind === 'text') { const row = texts.push(step, new Date()); note('text', `${row.handle}: ${row.text.slice(0, 60)}`); return { ok: true, row }; }
            if (kind === 'email') {
                const rec = mailRecord(step, new Date());
                note('email', `${rec.from}: ${rec.subject}`);
                send('sim-mail-arrived', [rec]);
                return { ok: true, email: rec };
            }
            return { ok: false, error: 'kind must be email or text' };
        },
        /**
         * Play a scenario's messages: one step (`step`), several (`steps`),
         * or, with `upTo` (days), every TEXT dated at or before that day: the
         * seed already planted the past's emails, calendar and memory, and
         * texts are the one kind only the live layer can deliver. A step with
         * `after` (the case it answers, e.g. a confirmation that follows the
         * person's reply) is never played by `upTo`, only by name. `at`
         * re-dates what is played (a step written for "+2d", played now as
         * "0d 10:05").
         */
        play(name, { step, steps, upTo, at } = {}) {
            if (!active) return { ok: false, error: 'not a test instance' };
            let sc;
            try { sc = loadScenario(name); } catch (e) { return { ok: false, error: e.message }; }
            const now = new Date();
            const want = new Set([].concat(step || [], steps || []));
            const chosen = (sc.steps || []).filter(s => (s.kind === 'email' || s.kind === 'text') && (
                want.size ? want.has(s.id) : upTo != null ? s.kind === 'text' && !s.after && parseAt(s.at, now) <= parseAt(`${upTo}d 23:59`, now) : false));
            const played = chosen.map(s => ({ id: s.id || null, ...api.arrive(at ? { ...s, at } : s) }));
            return { ok: true, played: played.length, steps: played.map(p => p.id) };
        },
        scenario(name) { try { return loadScenario(name); } catch (e) { return { error: e.message }; } }
    };
    return api;
}

module.exports = { createSimSources, parseAt, fill, mailRecord, textRow, Queue, SIM_ACCOUNT };
