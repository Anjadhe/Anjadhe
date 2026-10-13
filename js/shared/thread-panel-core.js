'use strict';
// Read-only thread panel builders and arrangement (V1-V6), shared by both hosts.
const ThreadPanelCore = {
    DAYS: 28,
    MAX_DAY_STRIPS: 4,
    MAX_PROGRESS: 3,
    MAX_COMING: 8,
    MAX_BILLS: 12,
    _providers: [],

    register(p) {
        if (!p || !p.id || typeof p.build !== 'function') return;
        this._providers = this._providers.filter(x => x.id !== p.id);
        this._providers.push({ order: 100, ...p });
        this._providers.sort((a, b) => a.order - b.order);
    },
    providers() { return this._providers.slice(); },

    /** The rows a thread's blocks are built from. Pure. */
    rowsOf(row) {
        if (!row || row.type === 'nenva') return [];
        if (Array.isArray(row.memberRows) && row.memberRows.length) return row.memberRows;
        return row.type === 'matter' || row.type === 'commitment' ? [row] : [];
    },

    /**
     * Every block this thread has something for (V2), each normalized by
     * AnswerBlocks so it draws in the drawer and in an answer alike, then
     * arranged (V3). Returns [{ id, label, block }]. Pure over ctx.
     *
     * A block's id is STABLE (`<provider>:<key>` when the provider gives a
     * key, else the provider id), so an arrangement saved today still names
     * the same block tomorrow. `ctx.arrangement` (see `arrange`) also asks
     * providers for more: `measures` draws those figures' lines too.
     */
    blocksFor(row, ctx = {}) {
        if (!row || row.type === 'nenva') return [];
        const rows = this.rowsOf(row);
        const AB = ctx.AnswerBlocks || (typeof module !== 'undefined' && module.exports ? require('./answer-block-data') : AnswerBlockData);
        const out = [];
        for (const p of this._providers) {
            let made = null;
            try { made = p.build(rows, ctx, row); } catch (e) { if (ctx.strict) throw e; if (typeof console !== 'undefined') console.warn(`[panels] ${p.id} failed:`, e); }
            const list = Array.isArray(made) ? made : made ? [made] : [];
            list.forEach((b, i) => {
                const key = b && b.key ? String(b.key) : list.length > 1 ? String(i + 1) : '';
                const block = AB ? AB.normalize(b) : b;
                if (block) out.push({ id: key ? `${p.id}:${key}` : p.id, label: p.label, block });
            });
        }
        return this.arrange(out, ctx.arrangement);
    },

    MAX_MEASURES: 3,
    /** Order by `arr.order`, drop `arr.hidden`; a block it never named keeps its place after the named ones. Never hides everything. Pure. */
    arrange(blocks, arr) {
        if (!arr || !blocks.length) return blocks;
        const hidden = new Set(arr.hidden || []);
        const kept = blocks.filter(b => !hidden.has(b.id));
        const list = kept.length ? kept : blocks;
        const rank = new Map((arr.order || []).map((id, i) => [id, i]));
        return list.map((b, i) => ({ b, i })).sort((x, y) => {
            const rx = rank.has(x.b.id) ? rank.get(x.b.id) : Infinity, ry = rank.has(y.b.id) ? rank.get(y.b.id) : Infinity;
            return rx - ry || x.i - y.i;
        }).map(x => x.b);
    },

    /** The figures a thread's goals keep that a line could show (from Commitments.progress). Pure over ctx. */
    measuresOf(row, ctx = {}) {
        const C = ctx.Commitments;
        if (!C || !C.progress) return [];
        const all = C.all();
        const names = new Set();
        for (const r of this.rowsOf(row)) {
            if (r.type !== 'commitment' || !r.rec) continue;
            const root = (C.rootOf && C.rootOf(r.rec, all)) || r.rec;
            const p = C.progress(root, all, ctx.today);
            for (const n of (p && p.names) || []) names.add(n);
        }
        return [...names];
    },

    /**
     * Check a proposed arrangement against what the thread can draw (V1, V6):
     * only ids it has, only figures it keeps, never everything hidden.
     * Returns { order, hidden, measures }. Pure.
     */
    vet(input = {}, ids = [], measures = []) {
        const have = new Set(ids);
        const pick = (xs, ok) => [...new Set((Array.isArray(xs) ? xs : []).map(x => String(x || '').trim()).filter(x => ok(x)))];
        const order = pick(input.order, x => have.has(x));
        let hidden = pick(input.hidden, x => have.has(x));
        if (hidden.length >= ids.length) hidden = [];
        const known = new Map(measures.map(m => [m.toLowerCase(), m]));
        const ms = pick((Array.isArray(input.measures) ? input.measures : []).map(m => known.get(String(m || '').trim().toLowerCase()) || ''), Boolean).slice(0, this.MAX_MEASURES);
        return { order, hidden, measures: ms };
    },

    _addDays(iso, n) { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; },
    /** "$1,284.50" → 1284.5; anything with no figure → null. */
    money(v) {
        if (typeof v === 'number') return Number.isFinite(v) ? v : null;
        const m = /(-)?\$?\s*(\d[\d,]*(?:\.\d+)?)/.exec(String(v == null ? '' : v));
        if (!m) return null;
        const n = Number(m[2].replace(/,/g, ''));
        return Number.isFinite(n) ? (m[1] ? -n : n) : null;
    },
    _day(v) { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || '')); return m ? m[1] : ''; },
    _monthLabel(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }); },
    _link(key) {
        const t = /^task:(.+)$/.exec(key || '');
        if (t) return `anjadhe://task/${t[1]}`;
        return /^matter:/.test(key || '') ? `anjadhe://matter/${key}` : undefined;
    }
};

// ── The built-in providers ──────────────────────────────────────────────

// A goal's figures: where it stands, the measure over time, and any other
// figure the arrangement asks a line for (Commitments.progress, CO3).
ThreadPanelCore.register({
    id: 'progress', label: 'Progress', order: 10,
    build(rows, ctx) {
        const C = ctx.Commitments;
        if (!C || !C.progress) return null;
        const all = C.all();
        const roots = new Map();
        for (const r of rows) {
            if (r.type !== 'commitment' || !r.rec) continue;
            const root = (C.rootOf && C.rootOf(r.rec, all)) || r.rec;
            if (root && !roots.has(root.id)) roots.set(root.id, root);
        }
        const asked = (ctx.arrangement && ctx.arrangement.measures) || [];
        const out = [];
        for (const root of [...roots.values()].slice(0, ThreadPanelCore.MAX_PROGRESS)) {
            const p = C.progress(root, all, ctx.today);
            if (!p) continue;
            const m = p.measure;
            const fmtOf = u => (u === 'time' ? 'clock' : u === '$' ? 'money' : 'number');
            const unitOf = u => (u && u !== 'time' && u !== '$' ? ` (${C.unitLabel ? C.unitLabel(u) : u})` : '');
            const items = [];
            if (m && m.last) items.push({ label: `${m.name} now${unitOf(m.unit)}`, value: m.last.value, format: fmtOf(m.unit) });
            if (p.aim) items.push({ label: 'Aim', value: C.aimText ? C.aimText(p.aim) : String(p.aim.target), format: 'text' });
            if (m && m.toGo != null) items.push({ label: 'To go', value: m.reached ? 'Reached' : (C.figure ? C.figure(m.toGo, m.unit) : m.toGo), format: 'text' });
            if (p.stage && p.stage.started) items.push({ label: 'This stage', value: `${p.stage.done} of ${p.stage.planned}`, format: 'text', sub: p.stage.title });
            else if (p.overall && p.overall.planned) items.push({ label: 'Done so far', value: `${p.overall.done} of ${p.overall.planned}`, format: 'text' });
            if (items.length) out.push({ key: `stats:${root.id}`, kind: 'stats', title: roots.size > 1 ? root.title : undefined, items });
            const line = (name, unit, points) => (points && points.length >= 2 ? { key: `line:${root.id}:${name}`, kind: 'line', title: roots.size > 1 ? root.title : undefined,
                label: `${name}${unitOf(unit)}`, format: fmtOf(unit), signed: false, points: points.slice(-120).map(x => ({ x: x.day, y: x.value })) } : null);
            if (m) { const l = line(m.name, m.unit, m.points); if (l) out.push(l); }
            for (const name of asked) {
                if ((m && name === m.name) || !(p.names || []).includes(name) || !C.series) continue;
                const l = line(name, (p.units || {})[name], C.series(root, name, all));
                if (l) out.push(l);
            }
        }
        return out;
    }
});

// A repeating commitment's last four weeks: done, skipped or missed, by day.
ThreadPanelCore.register({
    id: 'days', label: 'Days', order: 20,
    build(rows, ctx) {
        const C = ctx.Commitments;
        if (!C || !C.repeats || !C.occursOn || !ctx.today) return null;
        const out = [];
        for (const r of rows) {
            const c = r.rec;
            if (r.type !== 'commitment' || !c || c.state !== 'open' || !C.repeats(c)) continue;
            const days = [];
            for (let i = ThreadPanelCore.DAYS - 1; i >= 0; i--) {
                const d = ThreadPanelCore._addDays(ctx.today, -i);
                if (c.when && c.when.date && d < c.when.date) continue;
                if (!C.occursOn(c, d)) continue;
                const h = c.history && c.history[d];
                days.push({ date: d, state: h === 'done' ? 'done' : h === 'dropped' ? 'skipped' : d < ctx.today ? 'missed' : 'open' });
            }
            if (days.some(x => x.state !== 'open')) out.push({ key: c.id, kind: 'days', title: c.title, days });
            if (out.length >= ThreadPanelCore.MAX_DAY_STRIPS) break;
        }
        return out;
    }
});

// What is dated ahead: renewals, appointments, due dates (the same list the info page's get_sender reads).
ThreadPanelCore.register({
    id: 'coming', label: 'Coming up', order: 30,
    build(rows, ctx) {
        const up = ctx.upcoming ? ctx.upcoming(rows) : [];
        if (!up.length) return null;
        // The time of day rides its own column (minutes after midnight, drawn
        // as a clock), shown only when something listed has one.
        const shown = up.slice(0, ThreadPanelCore.MAX_COMING);
        const minutes = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
        const timed = shown.some(u => minutes(u.time) != null);
        return { kind: 'table', title: 'Coming up', sort: 'when',
            columns: [{ key: 'what', label: 'What', format: 'text' }, { key: 'when', label: 'When', format: 'date' }, ...(timed ? [{ key: 'time', label: 'Time', format: 'clock' }] : [])],
            rows: shown.map(u => ({ what: u.title, when: u.date, ...(timed ? { time: minutes(u.time) } : {}), _link: ThreadPanelCore._link(u.key) })) };
    }
});

// Amounts on the folders it holds (each bill is one folder): by month, and the latest ones.
ThreadPanelCore.register({
    id: 'amounts', label: 'Amounts', order: 40,
    build(rows) {
        const bills = [];
        for (const r of rows) {
            const m = r.rec;
            if (r.type !== 'matter' || !m) continue;
            const n = ThreadPanelCore.money(m.amount);
            // The folder's own day, else the day of its latest message (a receipt has no due date and a backfilled
            // one was not created when it arrived: 2026-10-12, three renewals drew as one month), else when it was made.
            const latest = (m.sources || []).map(s => s.at).filter(Boolean).sort().pop();
            const day = ThreadPanelCore._day((m.when && m.when.date) || latest || m.createdAt);
            if (n == null || !day) continue;
            bills.push({ what: r.title, when: day, amount: n, state: m.state === 'open' ? 'Open' : 'Settled', _link: ThreadPanelCore._link(r.key) });
        }
        if (!bills.length) return null;
        const out = [];
        const byMonth = new Map();
        for (const b of bills) byMonth.set(b.when.slice(0, 7), (byMonth.get(b.when.slice(0, 7)) || 0) + b.amount);
        if (byMonth.size >= 2) {
            const months = [...byMonth.keys()].sort().slice(-12);
            out.push({ key: 'months', kind: 'bar', title: 'By month', items: months.map(k => ({ label: ThreadPanelCore._monthLabel(k), value: Math.round(byMonth.get(k) * 100) / 100, format: 'money2' })) });
        }
        out.push({ key: 'latest', kind: 'table', title: 'Amounts', sort: '-when',
            columns: [{ key: 'what', label: 'What', format: 'text' }, { key: 'when', label: 'Date', format: 'date' }, { key: 'amount', label: 'Amount', format: 'money2' }, { key: 'state', label: 'Status', format: 'text' }],
            rows: bills.sort((a, b) => b.when.localeCompare(a.when)).slice(0, ThreadPanelCore.MAX_BILLS) });
        return out;
    }
});

if (typeof module !== 'undefined' && module.exports) module.exports = ThreadPanelCore;
