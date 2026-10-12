'use strict';
const CommitmentToolContract = Object.freeze({
    make(Commitments, CommitmentKinds) {
        const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const repeatText = c => !Commitments.repeats(c) ? undefined
        : c.repeat.rule === 'weekly' || c.repeat.rule === 'custom' ? `${c.repeat.rule} on ${c.repeat.days.map(d => DAYS[d]).join(', ')}` : c.repeat.rule;
    const brief = (c, today) => ({
        id: c.id, title: c.title, kind: Commitments.kindOf(c), state: c.state,
        when: c.when ? { date: c.when.date || undefined, time: c.when.time || undefined } : undefined,
        by: c.by || undefined, repeat: repeatText(c),
        // A repeat's next day at its own time, when that day alone was moved.
        nextDayOnly: (() => {
            if (!Commitments.repeats(c) || c.state !== 'open') return undefined;
            const next = Commitments.nextOn(c, today), t = next ? Commitments.timeOn(c, next) : null;
            return t && t.moved ? { date: next, time: t.time, end: t.end || undefined, note: 'that day only; every other time keeps the usual time' } : undefined;
        })(),
        doneToday: Commitments.repeats(c) ? Commitments.isDone(c, today) || undefined : undefined,
        parent: c.parent ? (Commitments.get(c.parent) || {}).title || c.parent : undefined,
        children: (() => { const k = Commitments.children(c.id); return k.length ? `${k.filter(x => x.state === 'open').length} open of ${k.length}` : undefined; })(),
        waitingOn: c.waitingOn ? c.waitingOn.who : undefined,
        // Coaching (docs/COACH.md §4): what it is coached as (its own or its
        // goal's), its aim, and the last day a repeating stage runs.
        domain: Commitments.domainOf(c) || undefined,
        aim: c.aim ? Commitments.aimText(c.aim) : undefined,
        until: c.until && Commitments.repeats(c) ? c.until : undefined,
        from: c.origin && c.origin.kind !== 'you' ? c.origin.kind : undefined
    });

    const FIELD_PROPS = {
        title: { type: 'string' },
        // What it IS (2026-10-11, js/core/commitment-kinds.js): always say it when adding.
        kind: { type: 'string', enum: Commitments.KINDS, get description() { return typeof CommitmentKinds !== 'undefined' ? `What it is, shown to the person as that word: ${CommitmentKinds.guide()}` : 'goal, project, habit or task'; } },
        note: { type: 'string', description: 'Free notes' },
        outcome: { type: 'string', description: 'For a big commitment: what done looks like' },
        parent: { type: 'string', description: 'Id of the bigger commitment this belongs to, from list_commitments; "" to detach' },
        date: { type: 'string', description: 'YYYY-MM-DD the day it happens or is due (a repeat starts here); "" for no date' },
        time: { type: 'string', description: 'HH:MM start time; "" for none' },
        end: { type: 'string', description: 'HH:MM end time' },
        by: { type: 'string', description: 'YYYY-MM-DD deadline or target; "" for none' },
        repeat: { type: 'string', enum: Commitments.RULES },
        days: { type: 'array', items: { type: 'string', enum: DAYS }, description: 'For weekly/custom repeats' },
        remind_minutes_before: { type: 'number' },
        remind_days_before: { type: 'array', items: { type: 'number' } },
        waiting_on: { type: 'string', description: 'Who it is waiting on; "" to clear' },
        // Coaching (docs/COACH.md §1).
        domain: { type: 'string', enum: [...Commitments.DOMAINS, ''], description: 'For a goal the person wants coaching on: what it is about. Set it on the goal, not its steps (they inherit it). "" to clear' },
        aim_measure: { type: 'string', description: 'For a goal: the ONE figure that shows progress, a short lowercase name ("distance", "weight", "bedtime", "saved"). "" removes the aim' },
        aim_target: { type: 'string', description: 'The number to reach, e.g. "6.2", "170", or HH:MM for a time of day ("23:00")' },
        aim_unit: { type: 'string', description: 'mi, km, lb, kg, min, h, time (a time of day), $, or the person\'s own unit; "" for a plain count' },
        aim_direction: { type: 'string', enum: ['up', 'down'], description: 'up: reach at least the target (distance, savings); down: come down to it (weight, a race time, a bedtime)' },
        aim_start: { type: 'string', description: 'Optional: the figure the person gave for where they start now, as they said it (same unit)' },
        until: { type: 'string', description: 'For a repeating step that is one STAGE of a plan: YYYY-MM-DD, the last day it runs. "" for no end' }
    };
    const toInput = (a, current = null) => {
        const x = {};
        const has = k => Object.prototype.hasOwnProperty.call(a, k);
        for (const k of ['title', 'note', 'outcome', 'state']) if (has(k)) x[k] = a[k];
        if (has('kind')) x.kind = a.kind || null;
        if (has('parent')) x.parent = a.parent || null;
        if (has('by')) x.by = a.by || null;
        if (has('date') || has('time') || has('end')) {
            const w = { ...(current && current.when ? current.when : {}) };
            if (has('date')) w.date = a.date || null;
            if (has('time')) w.time = a.time || null;
            if (has('end')) w.end = a.end || null;
            x.when = w.date || w.time ? w : null;
        }
        if (has('repeat') || has('days')) {
            const rule = has('repeat') ? a.repeat : (current && current.repeat.rule) || 'none';
            const days = has('days') ? (a.days || []).map(d => DAYS.indexOf(String(d).slice(0, 3).toLowerCase())).filter(n => n >= 0)
                : (current && current.repeat.days) || [];
            x.repeat = { rule, days };
        }
        if (has('remind_minutes_before') || has('remind_days_before')) {
            x.remind = { minutesBefore: has('remind_minutes_before') ? a.remind_minutes_before : (current && current.remind ? current.remind.minutesBefore : null),
                daysBefore: has('remind_days_before') ? a.remind_days_before : (current && current.remind ? current.remind.daysBefore : []) };
        }
        if (has('waiting_on')) x.waitingOn = a.waiting_on ? { who: a.waiting_on } : null;
        if (has('domain')) x.domain = a.domain || null;
        if (has('until')) x.until = a.until || null;
        if (['aim_measure', 'aim_target', 'aim_unit', 'aim_direction', 'aim_start'].some(has)) {
            if (has('aim_measure') && !a.aim_measure) x.aim = null;
            else {
                const cur = (current && current.aim) || {};
                const unit = has('aim_unit') ? a.aim_unit : cur.unit;
                const target = has('aim_target') ? a.aim_target : (cur.unit === 'time' && cur.target != null ? Commitments.figure(cur.target, 'time') : cur.target);
                x.aim = { measure: has('aim_measure') ? a.aim_measure : cur.measure, target, unit,
                    dir: has('aim_direction') ? a.aim_direction : (has('aim_start') ? undefined : cur.dir),
                    from: has('aim_start') && a.aim_start !== '' ? { value: a.aim_start, day: Commitments.today() } : cur.from };
            }
        }
        return x;
    };
        const definitions = Object.fromEntries([{ type: 'function', function: {
        name: 'list_commitments',
        description: 'The person\'s commitments: everything they said they would do. Each is a goal, a project, a habit or a task (its kind), and a goal or project holds its steps. Filter by words, kind, state, parent or a date window.',
        parameters: { type: 'object', properties: {
            search: { type: 'string', description: 'Words in the title or notes' },
            state: { type: 'string', enum: ['open', 'done', 'dropped', 'all'], description: 'Default open' },
            parent: { type: 'string', description: 'Only the steps of this commitment (id)' },
            top_level: { type: 'boolean', description: 'Only commitments with no parent (the big ones and loose tasks)' },
            kind: { type: 'string', enum: Commitments.KINDS, description: 'Only goals, projects, habits or tasks' },
            from: { type: 'string', description: 'YYYY-MM-DD: only ones happening or due on/after' },
            to: { type: 'string', description: 'YYYY-MM-DD: only ones happening or due on/before' }
        } }
    }}
, { type: 'function', function: {
        name: 'get_commitment',
        description: 'One commitment in full: its facts, its notes, its steps (for a big one), what it belongs to, recent history, where it came from, and the matter it is a step of. For a coached goal or any of its steps also its progress (the aim, the aim figure over time, the stage running now, planned and done, the figure names already kept) and how to coach its domain. Views: progress (a line of the aim figure), progress_numbers.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }}
, { type: 'function', function: {
        name: 'add_commitment',
        description: 'Add something the person said they would do, and say what it IS (kind: goal, project, habit or task). Fill in only what they said or clearly meant: a date, a time, a repeat, a reminder, what goal or project it belongs to (parent). A goal ("run a 10K by October") has an outcome and a "by" date; its steps are commitments with it as parent. When it comes from an email or text, or from a folder, pass from_message or from_matter so it keeps the link back, as "Add task" on an insight does.',
        parameters: { type: 'object', properties: { ...FIELD_PROPS,
            from_message: { type: 'string', description: 'The email or text it came from (a message id from get_matter or the email tools)' },
            from_matter: { type: 'string', description: 'The folder it came from (from list_matters)' }
        }, required: ['title'] }
    }}
, { type: 'function', function: {
        name: 'change_commitment',
        description: 'Change a commitment\'s facts: what it is (kind, e.g. "this is really a project"), title, notes, date or time, repeat, reminder, deadline, what it belongs to, or who it is waiting on. Give only the fields that change. On a repeating one a new time or date changes EVERY occurrence from now on; for one day only use move_one_day.',
        parameters: { type: 'object', properties: { id: { type: 'string' }, ...FIELD_PROPS }, required: ['id'] }
    }}].map(d => [d.function.name, d]));
        const list = (a = {}) => {
        const today = Commitments.today();
        let list = Commitments.all();
        const st = a.state || 'open';
        if (st !== 'all') list = list.filter(c => c.state === st);
        if (a.parent) list = list.filter(c => c.parent === a.parent);
        if (a.top_level) list = list.filter(c => !c.parent);
        if (a.kind) { const all = Commitments.all(); list = list.filter(c => Commitments.kindOf(c, all) === a.kind); }
        if (a.search) { const q = String(a.search).toLowerCase(); list = list.filter(c => `${c.title} ${c.note} ${c.outcome || ''} ${(c.tags || []).join(' ')}`.toLowerCase().includes(q)); }
        const from = Commitments.day(a.from), to = Commitments.day(a.to);
        if (from || to) list = list.filter(c => {
            const d = Commitments.repeats(c) ? Commitments.nextOn(c, from || today) : (c.when && c.when.date) || c.by;
            return d && (!from || d >= from) && (!to || d <= to);
        });
        const key = c => (Commitments.repeats(c) ? Commitments.nextOn(c, today) : (c.when && c.when.date) || c.by) || '9999';
        list.sort((x, y) => key(x).localeCompare(key(y)) || x.title.localeCompare(y.title));
        return { today, count: list.length, items: list.slice(0, 60).map(c => brief(c, today)), ...(list.length > 60 ? { note: `Showing 60 of ${list.length}; narrow with search, parent or dates.` } : {}) };
    };
    const dayText = iso => { const d = Commitments.day(iso); return d ? new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : String(iso || ''); };
    const clock = t => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? new Date(2000, 0, 1, +m[1], +m[2]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : String(t || ''); };
    const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
    const factRows = (a) => {
        const has = k => Object.prototype.hasOwnProperty.call(a, k) && a[k] !== undefined;
        const rows = [];
        if (has('title') && a.title) rows.push(['Rename to', a.title]);
        if (has('kind') && a.kind) rows.push(['Is a', typeof CommitmentKinds !== 'undefined' ? CommitmentKinds.get(a.kind).label : a.kind]);
        if (has('date') || has('time') || has('end')) {
            const day = has('date') ? (a.date ? dayText(a.date) : 'No date') : '';
            const time = a.time ? `${clock(a.time)}${a.end ? ` to ${clock(a.end)}` : ''}` : (has('time') && !a.time ? 'no time' : '');
            rows.push(['When', [day, time].filter(Boolean).join(', ')]);
        }
        if (has('repeat') || has('days')) {
            const days = (a.days || []).map(d => cap(String(d).slice(0, 3))).join(', ');
            rows.push(['Repeats', !a.repeat || a.repeat === 'none' ? (days ? `On ${days}` : 'No') : `${cap(a.repeat)}${days ? ` on ${days}` : ''}`]);
        }
        if (has('by')) rows.push(['By', a.by ? dayText(a.by) : 'No deadline']);
        if (has('parent')) rows.push(['Part of', a.parent ? titleOf(a.parent) : 'Nothing bigger']);
        if (has('remind_minutes_before') || has('remind_days_before')) {
            const m = a.remind_minutes_before, bits = [];
            if (m === 0) bits.push('at the start'); else if (m) bits.push(m >= 60 ? `${Math.round(m / 60)} h before` : `${m} min before`);
            for (const d of a.remind_days_before || []) bits.push(`${d} day${d === 1 ? '' : 's'} before`);
            rows.push(['Remind', bits.length ? cap(bits.join(', ')) : 'No']);
        }
        if (has('waiting_on')) rows.push(['Waiting on', a.waiting_on || 'No one']);
        if (has('domain')) rows.push(['Coached as', a.domain ? (typeof CoachDomains !== 'undefined' ? CoachDomains.label(a.domain) : cap(a.domain)) : 'Not coached']);
        if (['aim_measure', 'aim_target', 'aim_unit', 'aim_direction'].some(has)) {
            const aim = a.aim_measure === '' ? null : Commitments.vetAim({ measure: a.aim_measure, target: a.aim_target, unit: a.aim_unit, dir: a.aim_direction });
            rows.push(['Aim', a.aim_measure === '' ? 'None' : aim ? cap(Commitments.aimText(aim)) : `${a.aim_measure || ''} ${a.aim_target || ''} ${a.aim_unit || ''}`.trim()]);
        }
        if (has('aim_start') && a.aim_start) rows.push(['Starting from', `${a.aim_start}${a.aim_unit && a.aim_unit !== 'time' ? ` ${a.aim_unit}` : ''}`]);
        if (has('until')) rows.push(['Until', a.until ? dayText(a.until) : 'No end']);
        if (has('outcome') && a.outcome) rows.push(['Done looks like', a.outcome]);
        if (has('note') && a.note) { const n = String(a.note).replace(/\s+/g, ' ').trim(); rows.push(['Note', n.length > 220 ? n.slice(0, 219).trimEnd() + '…' : n]); }
        return rows;
    };
    const titleOf = id => (Commitments.get(id) || {}).title || id;
        return { fields: FIELD_PROPS, toInput, definitions, brief, list, factRows, dayText, clock, cap, titleOf };
    },
});
if (typeof module !== 'undefined' && module.exports) module.exports = CommitmentToolContract;
