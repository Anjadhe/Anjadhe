/**
 * InsightReport — where the noise comes from (2026-10-02, step 1 of the
 * noise plan in docs/MATTERS.md "Reducing noise").
 *
 * A READ-ONLY count over the last N days of what nenva made from mail and
 * texts, per kind of insight, and what became of it. It changes nothing; it
 * exists so the "worth telling" rules are decided on the person's own mail,
 * and so the same report run after a change shows whether noise fell.
 *
 * Per kind (the analysis `type`; within it the finer `kind` the insight
 * prompt names since 2026-10-02, else the cleaned subject):
 *   insights      shown on the Insights page
 *   needAction    the model said action was required
 *   tasks         tasks made from them; done / open / deleted
 *   doneNoAction  marked done, no action asked, no task  -> looked, nothing to do
 *   ignored       still unread after 3 days, no action asked -> never looked at
 *   notUseful     "Not useful" votes
 *   notified      notifications sent (counted from 2026-10-02 on)
 * plus what was read and filed as nothing, by reason, and the noisiest
 * senders. "Noise" = doneNoAction + ignored: insights that took attention
 * and gave nothing back ("Not useful" marks done, so it is inside the first).
 *
 * Pure; Node-testable (tests/insight-report-test.js).
 */
const InsightReport = {
    IGNORED_AFTER_MS: 3 * 86400000,

    /**
     * @param {object} d { analyses: {id: analysis}, emails: {id: {from, subject, at}},
     *   tasks: [scheduleItem], ledger: {key: taskId}, verdicts: {id: {why, at}},
     *   dismissed: {addr: [{type, summary, at}]}, notified: {type: count}, now, days }
     */
    build(d) {
        const now = d.now || Date.now();
        const since = now - (d.days || 30) * 86400000;
        const at = (v) => { const t = typeof v === 'number' ? v : Date.parse(v || 0); return isNaN(t) ? 0 : t; };
        const tasksBySource = new Map();
        for (const t of d.tasks || []) if (t && t.sourceEmailId) {
            const list = tasksBySource.get(t.sourceEmailId) || []; list.push(t); tasksBySource.set(t.sourceEmailId, list);
        }
        // Ledger entries whose task no longer exists = tasks the person deleted.
        const live = new Set((d.tasks || []).map(t => t && t.id));
        const deletedBySource = new Map();
        for (const [key, id] of Object.entries(d.ledger || {})) {
            if (!id || live.has(id) || /^(?:cal:|matter:)/.test(String(id))) continue;
            const cut = String(key).indexOf('::');   // EmailApp._actionKey: `${id}::${text}`
            const src = cut > 0 ? String(key).slice(0, cut) : String(key);
            deletedBySource.set(src, (deletedBySource.get(src) || 0) + 1);
        }
        const groups = new Map();
        const senders = new Map();
        const group = (type) => {
            if (!groups.has(type)) groups.set(type, { type, insights: 0, needAction: 0, tasks: 0, tasksDone: 0, tasksOpen: 0, tasksDeleted: 0,
                doneNoAction: 0, ignored: 0, notUseful: 0, notified: 0, filed: 0, kinds: new Map() });
            return groups.get(type);
        };
        for (const [id, a] of Object.entries(d.analyses || {})) {
            if (!a || a.rolledUp) continue;
            const m = (d.emails || {})[id];
            const when = at((m && m.at) || a.analyzedAt);
            if (!when || when < since) continue;
            const type = a.type || 'general';
            const g = group(type);
            g.insights++;
            const kind = this.kindOf(a, m);
            g.kinds.set(kind, (g.kinds.get(kind) || 0) + 1);
            const action = a.actionRequired === true;
            if (action) g.needAction++;
            const ts = tasksBySource.get(id) || [];
            g.tasks += ts.length + (deletedBySource.get(id) || 0);
            g.tasksDone += ts.filter(t => t.lastCompletedDate).length;
            g.tasksOpen += ts.filter(t => !t.lastCompletedDate).length;
            g.tasksDeleted += deletedBySource.get(id) || 0;
            // Filed (the assistant's "file", 2026-10-02) is not shown, so it is not noise:
            // counting it separately is how the report shows the rules working.
            // Filed = the assistant said "file" when it filed the message
            // (docs/MATTERS.md §13); the caller's own rule wins when given.
            const shown = d.worth ? d.worth(a, m) : (a.tell ? a.tell !== 'file' : true);
            if (!shown) g.filed++;
            if (shown && a.readAt && !action && !ts.length) g.doneNoAction++;
            if (shown && !a.readAt && !action && now - when > this.IGNORED_AFTER_MS) g.ignored++;
            const addr = this.address(m && m.from);
            if (addr) {
                const s = senders.get(addr) || { address: addr, name: this.name(m.from), insights: 0, noise: 0 };
                s.insights++;
                if (shown && ((a.readAt && !action && !ts.length) || (!a.readAt && !action && now - when > this.IGNORED_AFTER_MS))) s.noise++;
                senders.set(addr, s);
            }
        }
        for (const list of Object.values(d.dismissed || {})) {
            for (const x of list || []) if (at(x.at) >= since) group(x.type || 'general').notUseful++;
        }
        for (const [type, n] of Object.entries(d.notified || {})) group(type).notified += n;
        const filed = {};
        for (const v of Object.values(d.verdicts || {})) {
            if (!v || at(v.at) < since) continue;
            filed[v.why || 'other'] = (filed[v.why || 'other'] || 0) + 1;
        }
        const rows = [...groups.values()].map(g => ({
            ...g,
            // Not useful also marks the insight done, so it is already in
            // doneNoAction; adding it again would count one insight twice.
            noise: g.doneNoAction + g.ignored,
            kinds: [...g.kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([kind, n]) => ({ kind, n }))
        })).sort((a, b) => b.noise - a.noise || b.insights - a.insights);
        const total = rows.reduce((t, r) => ({ insights: t.insights + r.insights, noise: t.noise + r.noise, tasks: t.tasks + r.tasks,
            needAction: t.needAction + r.needAction, notified: t.notified + r.notified, filed: t.filed + r.filed }), { insights: 0, noise: 0, tasks: 0, needAction: 0, notified: 0, filed: 0 });
        return {
            days: d.days || 30, total, rows, filed,
            senders: [...senders.values()].filter(s => s.insights >= 2).sort((a, b) => b.noise - a.noise || b.insights - a.insights).slice(0, 8)
        };
    },

    kindOf(a, m) {
        const k = String((a && a.kind) || '').trim().toLowerCase();
        if (k && k !== 'null') return k;
        const s = String((m && m.subject) || '').toLowerCase().replace(/^((re|fwd?)\s*:\s*)+/, '')
            .replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:your|the|a|an|new)\s+/, '');
        return s ? `"${s.split(' ').slice(0, 4).join(' ')}"` : '(no subject)';
    },
    address(from) {
        const f = String(from || '');
        return ((f.match(/<([^>]+)>/) || [])[1] || f).trim().toLowerCase();
    },
    name(from) {
        const n = String(from || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim();
        return n || this.address(from);
    },

    /** The report as plain text (console and the Settings card). */
    text(r) {
        const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '–';
        const shown = r.total.insights - r.total.filed;
        const lines = [`Last ${r.days} days: ${r.total.insights} insights; ${shown} shown, ${r.total.filed} filed. Noise ${r.total.noise} of the ${shown} shown (${pct(r.total.noise, shown)}). ${r.total.tasks} tasks made.`];
        for (const g of r.rows) {
            lines.push(`${g.type}: ${g.insights} insights (${g.filed} filed), ${g.needAction} needing action, noise ${g.noise} (${pct(g.noise, g.insights)}: ${g.doneNoAction} done with nothing to do, ${g.ignored} never opened, ${g.notUseful} not useful); tasks ${g.tasks} (${g.tasksDone} done, ${g.tasksOpen} open, ${g.tasksDeleted} deleted)${g.notified ? `; ${g.notified} notifications` : ''}. Kinds: ${g.kinds.map(k => `${k.kind} ${k.n}`).join(', ')}`);
        }
        const filed = Object.entries(r.filed).map(([k, n]) => `${k} ${n}`).join(', ');
        if (filed) lines.push(`Read and filed as nothing: ${filed}.`);
        if (r.senders.length) lines.push(`Noisiest senders: ${r.senders.map(s => `${s.name} (${s.noise} of ${s.insights})`).join(', ')}.`);
        return lines.join('\n');
    }
};

if (typeof module !== 'undefined') module.exports = InsightReport;
