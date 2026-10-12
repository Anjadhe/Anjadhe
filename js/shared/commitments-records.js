'use strict';
// Shared validated record operations. Hosts supply only load/save and post-commit effects.
const CommitmentRecords = Object.freeze({
    UNITS: {"mi": ["distance", 1609.344], "km": ["distance", 1000], "m": ["distance", 1], "kg": ["weight", 1], "lb": ["weight", 0.45359237], "h": ["duration", 60], "min": ["duration", 1], "s": ["duration", 0.016666666666666666], "time": ["clock", 1]},
    convert(value, from, to) {
        if (from === to) return value;
        const a = this.UNITS[from], b = this.UNITS[to];
        if (!a || !b || a[0] !== b[0] || a[0] === 'clock') return null;
        return Math.round((value * a[1] / b[1]) * 100) / 100;
    },
    nums(text) {
        return (String(text || '').match(/\d+(?:[.,]\d+)*/g) || []).map(t => {
            if (/^\d{1,3}(,\d{3})+$/.test(t)) return Number(t.replace(/,/g, ''));
            return Number(t.replace(',', '.'));
        }).filter(Number.isFinite);
    },
    clocks(text) {
        const out = new Set();
        for (const m of String(text || '').matchAll(/(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?/gi)) {
            const h = +m[1], mm = +m[2];
            if (h > 23 || mm > 59) continue;
            if (m[3]) { const pm = /p/i.test(m[3]); const hh = (h % 12) + (pm ? 12 : 0); out.add(hh * 60 + mm); }
            else { out.add(h * 60 + mm); if (h < 12) out.add((h + 12) * 60 + mm); if (h === 12) out.add(mm); }
        }
        return out;
    },
    vetMeasures(list, quote, units = {}) {
        const kept = [], refused = [];
        const said = this.nums(quote), clocks = this.clocks(quote);
        for (const raw of (Array.isArray(list) ? list : []).slice(0, 8)) {
            const name = this.measureName(raw && raw.name);
            if (!name) { refused.push({ name: String((raw && raw.name) || ''), why: 'a measure needs a short name' }); continue; }
            if (kept.some(k => k.name === name)) continue;
            let unit = this.unit(raw.unit);
            const fixed = Object.prototype.hasOwnProperty.call(units, name) ? units[name] : null;
            if (unit === 'time' || (fixed === 'time' && typeof raw.value === 'string' && raw.value.includes(':'))) {
                const v = this.clockValue(raw.value);
                if (v == null || !clocks.has(v)) { refused.push({ name, why: 'that time is not in their words' }); continue; }
                if (fixed != null && fixed !== 'time') { refused.push({ name, why: `${name} is kept in ${fixed || 'a count'}` }); continue; }
                kept.push({ name, value: v, unit: 'time' });
                continue;
            }
            const v = typeof raw.value === 'number' ? raw.value : Number(String(raw.value || '').replace(/,/g, ''));
            if (!Number.isFinite(v)) { refused.push({ name, why: 'not a number' }); continue; }
            if (!said.some(n => Math.abs(n - v) < 1e-9)) { refused.push({ name, why: `${v} is not in their words` }); continue; }
            let value = v;
            if (fixed != null && fixed !== unit) {
                const c = this.convert(v, unit, fixed);
                if (c == null) { refused.push({ name, why: `${name} is kept in ${fixed || 'a count'}, and ${unit || 'a count'} is not that` }); continue; }
                value = c; unit = fixed;
            }
            kept.push({ name, value, unit });
        }
        return { kept, refused };
    },
    report(id, { day = null, how = null, quote = '', plan = false, measures = null } = {}, { by = 'you', why = '' } = {}) {
        const d = this._load();
        const c = d.items[id];
        if (!c) return { ok: false, error: `No commitment with id "${id}".` };
        if (how !== null && how !== 'done' && how !== 'dropped') return { ok: false, error: 'how must be done, dropped or null' };
        const today = this.today();
        const on = this.day(day) || today;
        if (on > today) return { ok: false, error: 'That day has not come yet.' };
        if (this.repeats(c) && !this.occursOn(c, on)) return { ok: false, error: 'It does not happen on that day.' };
        const q = String(quote || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!q && !how) return { ok: false, error: 'Nothing to keep.' };
        // Figures in the words (CO2): kept only when the quote holds them.
        const vm = Array.isArray(measures) && measures.length && q && !plan
            ? this.vetMeasures(measures, q, this.measureUnits(c, Object.values(d.items))) : { kept: [], refused: [] };
        const prevLog = (c.log && c.log[on]) || null;
        const before = { state: c.state, doneAt: c.doneAt, history: { [on]: (c.history || {})[on] || null }, log: { [on]: prevLog ? JSON.parse(JSON.stringify(prevLog)) : null } };
        const at = new Date().toISOString();
        const changed = [];
        const same = (prevLog || []).findIndex(e => e.quote === q);
        if (q && same < 0) {
            c.log = c.log || {};
            // `plan`: they said they WILL do it later that day. Kept as their
            // words, never counted as a report of how it went (AskAfter).
            c.log[on] = [...(prevLog || []), { at, quote: q, ...(plan && !how ? { plan: true } : {}), ...(vm.kept.length ? { measures: vm.kept } : {}) }];
            changed.push('log');
        } else if (q && vm.kept.length) {
            // The same words again, with figures read: a named one replaces
            // its earlier reading, the others stay.
            const had = prevLog[same].measures || [];
            const merged = [...had.filter(m => !vm.kept.some(k => k.name === m.name)), ...vm.kept]
                .sort((x, y) => had.findIndex(m => m.name === x.name) - had.findIndex(m => m.name === y.name));
            if (!this._same(had, merged)) {
                c.log = c.log || {};
                c.log[on] = prevLog.map((e, i) => i === same ? { ...e, measures: merged } : e);
                changed.push('log');
            }
        }
        if (how && !(c.history && c.history[on] === how && (this.repeats(c) || c.state === how))) {
            c.history = c.history || {};
            c.history[on] = how;
            if (!this.repeats(c)) { c.state = how; c.doneAt = at; }
            changed.push('state');
        }
        const figures = { measures: vm.kept, ...(vm.refused.length ? { refused: vm.refused } : {}) };
        if (!changed.length) return { ok: true, id, day: on, changed: [], ...figures };
        c.updatedAt = at;
        const ledgerId = this._ledger({ op: 'report', target: id, by, why: String(why || '').slice(0, 200), before, after: { state: c.state, history: { [on]: c.history ? c.history[on] || null : null }, log: { [on]: q } } });
        this._save();
        return { ok: true, id, day: on, ledgerId, changed, ...figures };
    },
    recentDays(c, today = this.today(), n = 5) {
        if (!this.repeats(c)) return [today];
        const out = [];
        const d = new Date(`${today}T12:00:00`);
        for (let i = 0; i < 35 && out.length < n; i++) {
            const s = this.iso(d);
            if (c.when && c.when.date && s < c.when.date) break;
            if (this.occursOn(c, s)) out.push(s);
            d.setDate(d.getDate() - 1);
        }
        return out;
    },
    ATTACH_KINDS: ["file", "note", "link"],
    DOMAINS: ["fitness", "health", "money", "parenting", "learning"],
    RULES: ["none", "daily", "weekdays", "weekly", "monthly", "yearly", "custom"],
    STATES: ["open", "done", "dropped"],
    UNIT_LABELS: {"mmhg": "mmHg", "mg/dl": "mg/dL", "mmol/l": "mmol/L", "°f": "°F", "°c": "°C", "kcal": "kcal", "bpm": "bpm"},
    UNIT_WORDS: {"mile": "mi", "miles": "mi", "mi": "mi", "km": "km", "k": "km", "kms": "km", "kilometer": "km", "kilometers": "km", "kilometre": "km", "kilometres": "km", "m": "m", "meter": "m", "meters": "m", "metre": "m", "metres": "m", "kg": "kg", "kgs": "kg", "kilo": "kg", "kilos": "kg", "kilogram": "kg", "kilograms": "kg", "lb": "lb", "lbs": "lb", "pound": "lb", "pounds": "lb", "h": "h", "hr": "h", "hrs": "h", "hour": "h", "hours": "h", "min": "min", "mins": "min", "minute": "min", "minutes": "min", "s": "s", "sec": "s", "secs": "s", "second": "s", "seconds": "s", "time": "time", "clock": "time", "time of day": "time"},
    _measureSources: [],
    _hm(v) { const t = this.time(v); return t ? +t.slice(0, 2) * 60 + +t.slice(3) : null; },
    _clock(mins) { return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`; },
    /**
     * Where one commitment stands on `today`, as plain lines for the
     * assistant (2026-10-05). The day is said BOTH ways, the date and how
     * far it is from today, by arithmetic: a chat continued the next day
     * read its own "moved to tomorrow" as still true and reported a move it
     * never made. Pure.
     */
    standing(c, today = this.today(), parentTitle = '') {
        if (!c) return [];
        const rel = (d) => {
            const n = Math.round((new Date(`${d}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86400000);
            return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? `in ${n} days` : `${-n} days ago`;
        };
        const name = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        const day = (d) => `${name(d)} (${d}), which is ${rel(d)}`;
        const w = c.when || {};
        const lines = [`Title: ${c.title || '(untitled)'}`, `Id: ${c.id}`];
        const done = this.isDone(c, today);
        if (this.repeats(c)) {
            const days = (c.repeat.days || []).map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).filter(Boolean).join(', ');
            lines.push(`Repeats: ${c.repeat.rule}${days ? ` on ${days}` : ''}${w.time ? ` at ${w.time}${w.end ? ` to ${w.end}` : ''} (the usual time, every time)` : ''}`);
            const next = c.state === 'open' ? this.nextOn(c, today) : null;
            const t = next ? this.timeOn(c, next) : null;
            if (next) lines.push(`Next time: ${day(next)}${t.time ? ` at ${t.time}${t.end ? ` to ${t.end}` : ''}` : ''}${t.moved ? ` (moved for that day only; every other time keeps the usual time)` : ''}${next === today && done ? ', already done' : ''}`);
        } else {
            lines.push(`When: ${w.date ? day(w.date) : 'no date'}${w.time ? ` at ${w.time}${w.end ? ` to ${w.end}` : ''}` : ''}`);
        }
        if (c.by) lines.push(`By: ${day(c.by)}`);
        if (c.until && this.repeats(c)) lines.push(`Repeats until: ${day(c.until)} (the end of this stage)`);
        lines.push(`Status: ${this.repeats(c) ? c.state : done ? c.state : (c.state === 'open' && w.date && w.date < today ? 'open, overdue' : c.state)}`);
        if (parentTitle) lines.push(`Part of: ${parentTitle}`);
        if (c.waitingOn && c.waitingOn.who) lines.push(`Waiting on: ${c.waitingOn.who}`);
        // Coaching (docs/COACH.md §4): the goal's domain, aim and progress, by
        // arithmetic, so the assistant never has to recall or guess them.
        try {
            const all = this.all();
            const root = this.rootOf(c, all) || c;
            const p = this.progress(root, all, today);
            if (p && (p.domain || p.aim || p.names.length || (root.id === c.id && p.stage))) {
                if (root.id !== c.id) lines.push(`Its goal: ${root.title} (id ${root.id})`);
                lines.push(...this.progressLines(p, root));
            }
        } catch { /* no store (a pure test): nothing to add */ }
        if (Array.isArray(c.attached) && c.attached.length) {
            lines.push('Attached to it (read one when it matters):');
            for (const x of c.attached) lines.push(x.kind === 'link' ? `- Link "${x.title}": ${x.id} (read_url; a private page such as Notion may need the person signed in, so say so if it cannot be read)`
                : x.kind === 'note' ? `- Text document "${x.title}" (get_note id ${x.id})`
                : `- File "${x.title}" in Documents (read_library_doc docId ${x.id})`);
        }
        return lines;
    },
    /**
     * Keep only well-formed fields. Pure over `items` (a map, for parent
     * checks). Returns { fields, dropped: [names] } — a field that fails its
     * check is dropped, never guessed at.
     */
    vetFields(input, items, selfId = null, now = Date.now()) {
        const out = {};
        const dropped = [];
        const lo = this.today(now - 10 * 365 * 86400000), hi = this.today(now + 10 * 365 * 86400000);
        const inRange = d => d && d >= lo && d <= hi ? d : null;
        const has = k => Object.prototype.hasOwnProperty.call(input || {}, k);
        if (!input || typeof input !== 'object') return { fields: out, dropped };
        if (has('title')) { const t = String(input.title || '').replace(/\s+/g, ' ').trim().slice(0, 200); if (t) out.title = t; else dropped.push('title'); }
        if (has('note')) out.note = String(input.note || '').slice(0, 20000);
        if (has('outcome')) out.outcome = input.outcome ? String(input.outcome).slice(0, 2000) : null;
        if (has('parent')) {
            const p = input.parent ? String(input.parent) : null;
            if (!p) out.parent = null;
            else if (p === selfId || !items[p] || this._isUnder(items, p, selfId)) dropped.push('parent');
            else out.parent = p;
        }
        if (has('when')) {
            const w = input.when;
            if (!w) out.when = null;
            else {
                const date = w.date ? inRange(this.day(w.date)) : null;
                const time = w.time ? this.time(w.time) : null;
                const end = w.end ? this.time(w.end) : null;
                if ((w.date && !date) || (w.time && !time) || (w.end && !end)) dropped.push('when');
                else out.when = date || time ? { date, time, end: time ? end : null } : null;
            }
        }
        if (has('by')) { const b = input.by ? inRange(this.day(input.by)) : null; if (input.by && !b) dropped.push('by'); else out.by = b; }
        if (has('repeat')) {
            const r = input.repeat || { rule: 'none' };
            const rule = this.RULES.includes(r.rule) ? r.rule : null;
            const days = [...new Set((r.days || []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
            if (!rule || ((rule === 'weekly' || rule === 'custom') && !days.length)) dropped.push('repeat');
            else out.repeat = { rule, days: rule === 'weekly' || rule === 'custom' ? days : [] };
        }
        if (has('remind')) {
            const r = input.remind;
            if (!r) out.remind = null;
            else {
                const mb = r.minutesBefore == null ? null : Number(r.minutesBefore);
                const db = [...new Set((r.daysBefore || []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 60))].sort((a, b) => a - b);
                if (mb != null && !(Number.isFinite(mb) && mb >= 0 && mb <= 7 * 1440)) dropped.push('remind');
                else out.remind = { minutesBefore: mb, daysBefore: db };
            }
        }
        if (has('waitingOn')) {
            const w = input.waitingOn;
            out.waitingOn = w && String(w.who || '').trim() ? { who: String(w.who).trim().slice(0, 80), since: this.day(w.since) || this.today(now) } : null;
        }
        if (has('state')) { if (this.STATES.includes(input.state)) out.state = input.state; else dropped.push('state'); }
        // A mirrored source's last-seen copy (Apple Reminders): what it said
        // when this record last matched it, so a local edit wins that field.
        if (has('sourceSnapshot')) out.sourceSnapshot = input.sourceSnapshot && typeof input.sourceSnapshot === 'object' ? JSON.parse(JSON.stringify(input.sourceSnapshot)) : null;
        if (has('kind')) { const k = input.kind ? String(input.kind).toLowerCase().trim() : null; if (k && !this.KINDS.includes(k)) dropped.push('kind'); else out.kind = k; }
        if (has('tags')) out.tags = [...new Set((input.tags || []).map(t => String(t).trim()).filter(Boolean))].slice(0, 20);
        // Coaching (docs/COACH.md §1, 2026-10-09): what it is coached as, the
        // number it aims at, and the last day a repeating stage runs.
        if (has('domain')) { const v = input.domain ? String(input.domain).toLowerCase().trim() : null; if (v && !this.DOMAINS.includes(v)) dropped.push('domain'); else out.domain = v; }
        if (has('aim')) { if (!input.aim) out.aim = null; else { const a = this.vetAim(input.aim); if (a) out.aim = a; else dropped.push('aim'); } }
        if (has('until')) { const u = input.until ? inRange(this.day(input.until)) : null; if (input.until && !u) dropped.push('until'); else out.until = u; }
        // What it is about, attached (2026-10-08): a file in Documents, a
        // text document, or a link (a Notion page, a form). Ids and URLs
        // kept, with the title as it was when attached.
        if (has('attached')) {
            const seen = new Set();
            out.attached = (Array.isArray(input.attached) ? input.attached : []).map(x => {
                if (!x) return null;
                const kind = this.ATTACH_KINDS.includes(x.kind) ? x.kind : 'file';
                const id = kind === 'link' ? this.linkUrl(x.id || x.url) : String(x.id || '').trim().slice(0, 200);
                if (!id) return null;
                const title = String(x.title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || (kind === 'link' ? this.linkTitle(id) : '');
                return { kind, id, title };
            }).filter(x => x && !seen.has(`${x.kind}:${x.id}`) && seen.add(`${x.kind}:${x.id}`)).slice(0, 30);
        }
        return { fields: out, dropped };
    },
    /** An http(s) URL from what the person pasted ("notion.so/…" gets https://), or null. Pure. */
    linkUrl(v) {
        let s = String(v || '').trim();
        if (!s || /\s/.test(s)) return null;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) { if (!/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(s)) return null; s = `https://${s}`; }
        try { const u = new URL(s); return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href.slice(0, 2000) : null; } catch { return null; }
    },
    /**
     * A readable name for a link from the URL alone (no fetch). A Notion or
     * Google page's slug is its title once the trailing id is gone:
     * notion.so/team/Lease-renewal-3f2a…  → "Lease renewal". Pure.
     */
    linkTitle(url) {
        let u;
        try { u = new URL(url); } catch { return String(url || '').slice(0, 200); }
        const host = u.hostname.replace(/^www\./, '');
        const segs = u.pathname.split('/').filter(Boolean).map(x => { try { return decodeURIComponent(x); } catch { return x; } });
        for (let i = segs.length - 1; i >= 0; i--) {
            if (segs[i].length >= 8 && /\d/.test(segs[i]) && !/[-_+ .]/.test(segs[i])) continue;   // an id, not a name
            const t = segs[i].replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_]?[0-9a-f]{32}$/i, '').replace(/[-_+]+/g, ' ').trim();
            if (t && /[a-z]/i.test(t) && !/^(edit|view|d|s|p|u|file|document|spreadsheets|presentation)$/i.test(t) && t.length > 1) return `${t.charAt(0).toUpperCase()}${t.slice(1)}`.slice(0, 200);
        }
        return host;
    },
    /** Is `id` somewhere under `ancestor`? (No cycles through parent.) */
    _isUnder(items, id, ancestor) {
        if (!ancestor) return false;
        let cur = items[id], hops = 0;
        while (cur && cur.parent && hops++ < 50) { if (cur.parent === ancestor) return true; cur = items[cur.parent]; }
        return false;
    },
    /** A unit as kept: a known one canonical, anything else short and lowercase ('' = a count). Pure. */
    unit(u) {
        const w = String(u == null ? '' : u).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 16);
        return this.UNIT_WORDS[w] || w;
    },
    measureName(n) {
        const s = String(n || '').toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
        return /^[a-z0-9]/.test(s) && /[a-z]/.test(s) ? s : null;
    },
    /** A clock value as minutes: 1420, "23:40", "11:40 pm". Pure. */
    clockValue(v) {
        if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v < 1440 ? v : null;
        const m = /^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i.exec(String(v || '').trim());
        if (!m || +m[1] > 23 || +m[2] > 59) return null;
        let h = +m[1];
        if (m[3]) h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0);
        return h * 60 + +m[2];
    },
    /** A goal's aim, checked, or null. `target` may be a clock ("23:00") for a time. Pure. */
    vetAim(a) {
        if (!a || typeof a !== 'object') return null;
        const measure = this.measureName(a.measure);
        const unit = this.unit(a.unit);
        if (!measure) return null;
        const target = unit === 'time' ? this.clockValue(a.target) : Number(a.target);
        if (target == null || !Number.isFinite(target)) return null;
        const dir = a.dir === 'down' || a.dir === 'up' ? a.dir : null;
        const out = { measure, target, unit, dir: dir || 'up' };
        if (a.from && typeof a.from === 'object') {
            const fv = unit === 'time' ? this.clockValue(a.from.value) : Number(a.from.value);
            const fd = this.day(a.from.day);
            if (fv != null && Number.isFinite(fv) && fd) out.from = { value: fv, day: fd };
            if (!dir && out.from) out.dir = out.from.value > target ? 'down' : 'up';
        }
        return out;
    },
    /** The goal at the top of `c`'s family (itself when it has no parent). Pure over `all`. */
    rootOf(c, all = this.all()) {
        const by = new Map(all.map(x => [x.id, x]));
        let cur = c, hops = 0;
        while (cur && cur.parent && by.get(cur.parent) && hops++ < 50) cur = by.get(cur.parent);
        return cur;
    },
    /** `c` and everything under it. Pure over `all`. */
    family(c, all = this.all()) {
        const out = [c], seen = new Set([c.id]);
        for (let i = 0; i < out.length; i++) for (const k of all) if (k.parent === out[i].id && !seen.has(k.id)) { seen.add(k.id); out.push(k); }
        return out;
    },
    /** What it is coached as: its own domain, else the nearest one above it. Pure over `all`. */
    domainOf(c, all = this.all()) {
        const by = new Map(all.map(x => [x.id, x]));
        let cur = c, hops = 0;
        while (cur && hops++ < 50) { if (cur.domain) return cur.domain; cur = cur.parent ? by.get(cur.parent) : null; }
        return null;
    },
    /** name → unit for the measures kept anywhere in `c`'s goal (first use wins), the aim's first. Pure. */
    measureUnits(c, all = this.all()) {
        const root = this.rootOf(c, all) || c;
        const units = {};
        for (const x of this.family(root, all)) if (x.aim && x.aim.measure && !(x.aim.measure in units)) units[x.aim.measure] = x.aim.unit;
        const entries = [];
        for (const x of this.family(root, all)) for (const [day, es] of Object.entries(x.log || {})) for (const e of es || []) for (const m of e.measures || []) entries.push([day, e.at || '', m]);
        entries.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
        for (const [, , m] of entries) if (!(m.name in units)) units[m.name] = m.unit;
        return units;
    },
    /** One measure over `c` and everything under it: [{day, value}], one per day (the day's last). Pure but for the sources. */
    series(c, name, all = this.all()) {
        const byDay = new Map();
        if (c && !c.parent) for (const f of this._measureSources) {
            let pts = [];
            try { pts = f(c, name) || []; } catch { pts = []; }
            for (const p of pts) if (p && this.day(p.day) && Number.isFinite(Number(p.value))) byDay.set(p.day, { at: '', value: Number(p.value) });
        }
        for (const x of this.family(c, all)) for (const [day, es] of Object.entries(x.log || {})) for (const e of es || []) for (const m of e.measures || []) {
            if (m.name !== name) continue;
            const prev = byDay.get(day);
            if (!prev || String(e.at || '') >= prev.at) byDay.set(day, { at: String(e.at || ''), value: m.value });
        }
        return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, value: v.value }));
    },
    _addDays(iso, n) { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return this.iso(d); },
    /** Planned / done / skipped occurrences of one commitment from its start to `to` (inclusive). Pure. */
    tally(c, to) {
        const out = { planned: 0, done: 0, skipped: 0 };
        const h = c.history || {};
        if (!this.repeats(c)) {
            const d = (c.when && c.when.date) || null;
            if ((d && d <= to) || c.state !== 'open') { out.planned = 1; if (c.state === 'done') out.done = 1; else if (c.state === 'dropped') out.skipped = 1; }
            return out;
        }
        const start = (c.when && c.when.date) || Object.keys(h).sort()[0];
        if (!start) return out;
        const end = c.until && c.until < to ? c.until : to;
        for (let s = start, i = 0; s <= end && i < 1500; s = this._addDays(s, 1), i++) {
            if (!this.occursOn(c, s)) continue;
            out.planned++;
            if (h[s] === 'done') out.done++; else if (h[s] === 'dropped') out.skipped++;
        }
        return out;
    },
    /**
     * Where a goal stands, by arithmetic (CO3): its domain and aim, the aim's
     * measure over time, the stage running now and the counts. ONE reader
     * for the sheet, the chat's block, get_commitment and the coach. Pure.
     */
    progress(goal, all = this.all(), today = this.today()) {
        if (!goal) return null;
        const fam = this.family(goal, all);
        const units = this.measureUnits(goal, all);
        const names = Object.keys(units).filter(n => fam.some(x => Object.values(x.log || {}).some(es => (es || []).some(e => (e.measures || []).some(m => m.name === n)))));
        const aim = goal.aim || null;
        let measure = null;
        const pick = aim ? aim.measure : names.slice().sort((a, b) => this.series(goal, b, all).length - this.series(goal, a, all).length)[0];
        if (pick) {
            const points = this.series(goal, pick, all);
            const dir = aim ? aim.dir : 'up';
            if (points.length || aim) {
                const vals = points.map(p => p.value);
                const first = aim && aim.from ? aim.from : points[0] || null;
                const last = points[points.length - 1] || null;
                const best = vals.length ? (dir === 'down' ? Math.min(...vals) : Math.max(...vals)) : null;
                const round = v => Math.round(v * 100) / 100;
                const toGo = aim && last ? round(Math.max(0, dir === 'down' ? last.value - aim.target : aim.target - last.value)) : null;
                measure = { name: pick, unit: units[pick] != null ? units[pick] : (aim ? aim.unit : ''), points, first, last, best, toGo, reached: toGo === 0 };
            }
        }
        // The stage running now: a repeating step that has started and not ended.
        const steps = fam.filter(x => x !== goal && this.repeats(x) && x.state === 'open');
        const running = steps.filter(x => (!x.when || !x.when.date || x.when.date <= today) && (!x.until || x.until >= today))
            .sort((a, b) => String((b.when && b.when.date) || '').localeCompare(String((a.when && a.when.date) || '')));
        const next = steps.filter(x => x.when && x.when.date > today).sort((a, b) => a.when.date.localeCompare(b.when.date));
        const st = running[0] || next[0] || null;
        const stage = st ? { id: st.id, title: st.title, from: (st.when && st.when.date) || null, until: st.until || null, started: !!running[0], ...this.tally(st, today) } : null;
        const overall = { planned: 0, done: 0, skipped: 0, open: 0 };
        for (const x of fam) {
            if (x === goal && !this.repeats(x)) continue;
            const t = this.tally(x, today);
            overall.planned += t.planned; overall.done += t.done; overall.skipped += t.skipped;
            if (!this.repeats(x) && x.state === 'open' && !(x.when && x.when.date && x.when.date <= today)) overall.open++;
        }
        return { domain: this.domainOf(goal, all), aim, measure, stage, overall, names, units };
    },
    unitLabel(u) { return this.UNIT_LABELS[String(u || '')] || String(u || ''); },
    /** A figure as a person reads it: "5.2 mi", "11:40 PM", "48 min", "128 mmHg". Pure. */
    figure(value, unit) {
        if (value == null) return '';
        if (unit === 'time') { const h = Math.floor(value / 60), m = value % 60; return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; }
        const v = Math.round(value * 100) / 100;
        if (unit === '$') return `$${Math.round(value).toLocaleString('en-US')}`;
        return unit ? `${v.toLocaleString('en-US')} ${this.unitLabel(unit)}` : v.toLocaleString('en-US');
    },
    /** The aim in words: "distance 6.2 mi or more", "weight 170 lb or less". Pure. */
    aimText(aim) {
        if (!aim) return '';
        const t = this.figure(aim.target, aim.unit);
        if (aim.unit === 'time') return `${aim.measure} by ${t}`;
        return `${aim.measure} ${t} or ${aim.dir === 'down' ? 'less' : 'more'}`;
    },
    /** progress as plain lines for the assistant (standing, plan_outcome, the coach). Pure. */
    progressLines(p, goal) {
        if (!p) return [];
        const lines = [];
        if (p.domain) lines.push(`Coached as: ${p.domain}`);
        if (p.aim) lines.push(`Aim: ${this.aimText(p.aim)}${goal && goal.by ? ` by ${goal.by}` : ''}`);
        const m = p.measure;
        if (m && m.last) {
            const f = v => this.figure(v, m.unit);
            const bits = [`${m.name}: ${f(m.last.value)} on ${m.last.day}`];
            if (m.first && m.first.day !== m.last.day) bits.push(`from ${f(m.first.value)} on ${m.first.day}`);
            if (m.points.length > 2) bits.push(`best ${f(m.best)}`);
            if (m.toGo != null) bits.push(m.reached ? 'aim reached' : `${f(m.toGo)} to go`);
            bits.push(`${m.points.length} reading${m.points.length === 1 ? '' : 's'}`);
            lines.push(`Progress: ${bits.join(', ')}`);
        } else if (p.aim) lines.push(`Progress: no ${p.aim.measure} figure said yet`);
        if (p.stage) lines.push(`${p.stage.started ? 'This stage' : 'Next stage'}: ${p.stage.title}${p.stage.from ? `, from ${p.stage.from}` : ''}${p.stage.until ? ` to ${p.stage.until}` : ''}${p.stage.started ? `, ${p.stage.done} of ${p.stage.planned} done so far${p.stage.skipped ? `, ${p.stage.skipped} skipped` : ''}` : ''}`);
        if (p.overall.planned) lines.push(`So far overall: ${p.overall.done} of ${p.overall.planned} planned sessions or steps done${p.overall.skipped ? `, ${p.overall.skipped} skipped` : ''}`);
        if (p.names.length) lines.push(`Measures kept (reuse these names and units): ${p.names.map(n => `${n} (${this.unitLabel(p.units[n]) || 'count'})`).join(', ')}`);
        return lines;
    },
    all() { return Object.values(this._load().items); },
    get(id) { return this._load().items[id] || null; },
    children(id) { return this.all().filter(c => c.parent === id); },
    _ledger(entry) {
        const d = this._load();
        const at = new Date().toISOString();
        const e = { id: `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, at, updatedAt: at, ...entry };
        d.ledger.push(e);
        this._afterWrite(e);
        return e.id;
    },
    _same(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); },
    /**
     * Pure fold of checked fields into a record. Returns the changed field
     * names (empty: nothing to write).
     */
    applyFields(c, fields) {
        const changed = [];
        for (const [k, v] of Object.entries(fields)) {
            if (this._same(c[k], v)) continue;
            c[k] = v;
            changed.push(k);
        }
        return changed;
    },
    /**
     * THE door (C4). `by` is 'you' | 'assistant' | 'facts' | 'migration'.
     * Returns { ok, id, ledgerId, changed, dropped } or { ok:false, error }.
     */
    change(id, input, { by = 'you', why = '' } = {}) {
        const d = this._load();
        const c = d.items[id];
        if (!c) return { ok: false, error: `No commitment with id "${id}".` };
        const { fields, dropped } = this.vetFields(input, d.items, id);
        const before = {};
        for (const k of Object.keys(fields)) before[k] = c[k] === undefined ? null : JSON.parse(JSON.stringify(c[k]));
        const changed = this.applyFields(c, fields);
        if (!changed.length) return { ok: true, id, changed: [], dropped };
        c.updatedAt = new Date().toISOString();
        const after = {};
        for (const k of changed) { after[k] = fields[k]; }
        const slim = {};
        for (const k of changed) slim[k] = before[k];
        const ledgerId = this._ledger({ op: 'change', target: id, by, why: String(why || '').slice(0, 200), before: slim, after });
        this._save();
        return { ok: true, id, ledgerId, changed, dropped };
    },
    /** A new commitment. `title` is required; everything else is checked like a change. */
    create(input, { by = 'you', why = '', id = null, origin = null } = {}) {
        const d = this._load();
        const { fields, dropped } = this.vetFields(input, d.items, null);
        if (!fields.title) return { ok: false, error: 'A commitment needs a title.' };
        const now = new Date().toISOString();
        const newId = id && !d.items[id] ? id : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const c = this.blank(newId, now);
        this.applyFields(c, fields);
        c.shape = fields.outcome ? 'goal' : 'task';
        c.origin = origin || { kind: by === 'assistant' ? 'chat' : 'you' };
        d.items[newId] = c;
        delete d.tombstones[newId];
        const ledgerId = this._ledger({ op: 'create', target: newId, by, why: String(why || '').slice(0, 200), after: { title: c.title } });
        this._save();
        return { ok: true, id: newId, ledgerId, dropped };
    },
    blank(id, nowISO) {
        return { id, title: '', note: '', parent: null, outcome: null, when: null, by: null,
            repeat: { rule: 'none', days: [] }, remind: null, waitingOn: null, state: 'open', history: {},
            origin: { kind: 'you' }, read: null, timer: null, tags: [], createdAt: nowISO, updatedAt: nowISO, doneAt: null };
    },
    /**
     * Done or not done, said as a direction (2026-10-11: the one replacement
     * for the old task toggle). A one-time commitment resolves or reopens; a
     * repeat marks or clears `date`'s occurrence (default today). A no-op
     * when it already is that way. Returns resolve/reopen's result.
     */
    setDone(id, done, { by = 'you', why = '', date = null } = {}) {
        const c = this.get(id);
        if (!c) return { ok: false, error: 'No such commitment.' };
        const day = this.day(date) || this.today();
        const isDone = this.repeats(c) ? this.isDone(c, day) : c.state === 'done';
        if (isDone === !!done) return { ok: true, changed: [] };
        return done ? this.resolve(id, 'done', { by, why, date: day }) : this.reopen(id, { by, date: day });
    },
    resolve(id, how = 'done', { by = 'you', why = '', date = null } = {}) {
        const d = this._load();
        const c = d.items[id];
        if (!c) return { ok: false, error: `No commitment with id "${id}".` };
        if (how !== 'done' && how !== 'dropped') return { ok: false, error: 'how must be done or dropped' };
        const day = this.day(date) || this.today();
        const before = { state: c.state, doneAt: c.doneAt, history: { [day]: (c.history || {})[day] || null } };
        c.history = c.history || {};
        if (c.history[day] === how && (this.repeats(c) || c.state === how)) return { ok: true, id, changed: [] };
        c.history[day] = how;
        if (!this.repeats(c)) { c.state = how; c.doneAt = new Date().toISOString(); }
        c.updatedAt = new Date().toISOString();
        const ledgerId = this._ledger({ op: how, target: id, by, why: String(why || '').slice(0, 200), before, after: { state: c.state, history: { [day]: how } } });
        this._save();
        return { ok: true, id, ledgerId, changed: ['state'] };
    },
    /**
     * ONE day of a repeat at another time, that day only (2026-10-05). The
     * repeat and its usual time are untouched. `time` empty puts the day
     * back to the usual time. The day must be a real occurrence, today or
     * later; with no `end` the usual length is kept. Ledgered; Undo
     * restores exactly what was there. The same day only: a day of it
     * cannot be moved to another date (the old readers behind the bridge
     * cannot show that).
     */
    moveDay(id, { day = null, time = null, end = null } = {}, { by = 'you', why = '' } = {}) {
        const d = this._load();
        const c = d.items[id];
        if (!c) return { ok: false, error: `No commitment with id "${id}".` };
        if (!this.repeats(c)) return { ok: false, error: 'It does not repeat: change its time itself.' };
        const today = this.today();
        const on = this.day(day) || this.nextOn(c, today);
        if (!on || on < today) return { ok: false, error: 'That day has passed.' };
        if (!this.occursOn(c, on)) return { ok: false, error: 'It does not happen on that day.' };
        const w = c.when || {};
        let val = null;
        if (time) {
            const t = this.time(time);
            if (!t) return { ok: false, error: 'The time must be HH:MM.' };
            let e = end ? this.time(end) : null;
            if (end && !e) return { ok: false, error: 'The end time must be HH:MM.' };
            if (!e && w.time && w.end && this._hm(w.end) > this._hm(w.time)) {
                const m = this._hm(t) + (this._hm(w.end) - this._hm(w.time));
                e = m < 1440 ? this._clock(m) : null;
            }
            if (e && this._hm(e) <= this._hm(t)) e = null;
            // The usual time, said again, is no exception.
            if (!(t === (w.time || null) && (e || null) === (w.time ? (w.end || null) : null))) val = { time: t, end: e };
        }
        const prev = (c.moved && c.moved[on]) || null;
        if (this._same(prev, val)) return { ok: true, id, day: on, changed: [], ...this.timeOn(c, on) };
        c.moved = { ...(c.moved || {}) };
        if (val) c.moved[on] = val; else delete c.moved[on];
        if (!Object.keys(c.moved).length) delete c.moved;
        c.updatedAt = new Date().toISOString();
        const ledgerId = this._ledger({ op: 'move-day', target: id, by, why: String(why || '').slice(0, 200), before: { moved: { [on]: prev } }, after: { moved: { [on]: val } } });
        this._save();
        return { ok: true, id, day: on, ledgerId, changed: ['moved'], ...this.timeOn(c, on) };
    },
    reopen(id, { by = 'you', date = null } = {}) {
        const d = this._load();
        const c = d.items[id];
        if (!c) return { ok: false, error: `No commitment with id "${id}".` };
        const day = this.day(date) || this.today();
        const before = { state: c.state, doneAt: c.doneAt, history: { [day]: (c.history || {})[day] || null } };
        let changed = false;
        if (this.repeats(c)) { if (c.history && c.history[day]) { delete c.history[day]; changed = true; } }
        else if (c.state !== 'open') { c.state = 'open'; c.doneAt = null; changed = true; }
        if (!changed) return { ok: true, id, changed: [] };
        c.updatedAt = new Date().toISOString();
        const ledgerId = this._ledger({ op: 'reopen', target: id, by, before, after: { state: c.state } });
        this._save();
        return { ok: true, id, ledgerId, changed: ['state'] };
    },
    /** Remove (tombstoned, C8). Its children move up to its parent, never deleted with it. */
    remove(id, { by = 'you', why = '' } = {}) {
        const d = this._load();
        const c = d.items[id];
        if (!c) return { ok: false, error: `No commitment with id "${id}".` };
        const kids = this.children(id).map(k => k.id);
        const now = new Date().toISOString();
        for (const k of kids) { d.items[k].parent = c.parent || null; d.items[k].updatedAt = now; }
        delete d.items[id];
        d.tombstones[id] = now;
        const ledgerId = this._ledger({ op: 'remove', target: id, by, why: String(why || '').slice(0, 200), before: JSON.parse(JSON.stringify(c)), after: { children: kids } });
        this._save();
        return { ok: true, id, ledgerId, movedChildren: kids };
    },
    /** Undo one ledger entry, if what it changed has not been changed since. */
    undo(ledgerId) {
        const d = this._load();
        const e = d.ledger.find(x => x.id === ledgerId);
        if (!e || e.undone) return { ok: false, error: 'Nothing to undo.' };
        const later = d.ledger.slice(d.ledger.indexOf(e) + 1).some(x => x.target === e.target && !x.undone);
        if (later) return { ok: false, error: 'It has been changed again since; undo that first.' };
        const c = d.items[e.target];
        const now = new Date().toISOString();
        if (e.op === 'create') { if (c) { delete d.items[e.target]; d.tombstones[e.target] = now; } }
        else if (e.op === 'import') {
            if (e.before) d.items[e.target] = { ...e.before, updatedAt: now };
            else if (c) { delete d.items[e.target]; d.tombstones[e.target] = now; }
        }
        else if (e.op === 'remove') {
            d.items[e.target] = { ...e.before, updatedAt: now };
            delete d.tombstones[e.target];
            for (const k of (e.after && e.after.children) || []) if (d.items[k]) { d.items[k].parent = e.target; d.items[k].updatedAt = now; }
        } else if (c) {
            for (const [k, v] of Object.entries(e.before || {})) {
                if (k === 'history') { c.history = c.history || {}; for (const [day, h] of Object.entries(v || {})) { if (h) c.history[day] = h; else delete c.history[day]; } }
                else if (k === 'log') { c.log = c.log || {}; for (const [day, l] of Object.entries(v || {})) { if (l) c.log[day] = l; else delete c.log[day]; } }
                else if (k === 'moved') { c.moved = { ...(c.moved || {}) }; for (const [day, m] of Object.entries(v || {})) { if (m) c.moved[day] = m; else delete c.moved[day]; } if (!Object.keys(c.moved).length) delete c.moved; }
                else c[k] = v;
            }
            c.updatedAt = now;
        } else return { ok: false, error: 'It no longer exists.' };
        e.undone = now;
        e.updatedAt = now;
        this._save();
        this._afterWrite({ ...e, op: 'undo', undoneOp: e.op, by: 'you' });
        return { ok: true, id: e.target };
    },
});
if (typeof module !== 'undefined' && module.exports) module.exports = CommitmentRecords;
