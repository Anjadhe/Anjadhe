/**
 * Commitment tools — the assistant reads and changes the person's
 * commitments (docs/COMMITMENTS.md §6, phase 1, 2026-10-03).
 *
 * Registered only while the `commitments` flag is on; until phase 4 the old
 * task and project tools stay the ones a normal chat uses. Every write goes
 * through Commitments' one door (C4) and asks first (C4: the agent proposes,
 * the person taps), with the exact change in the consent dialog. Dates are
 * computed by code, never by the model (C1): move_commitments takes intent
 * ("shift by 7 days", "start on Monday") and does the arithmetic. Blocked in
 * untrusted turns (C9). Group `commitments`, loaded with use_tools.
 */
(() => {
    if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function' || typeof Commitments === 'undefined') return;
    if (typeof FEATURES === 'undefined' || !FEATURES.isEnabled('commitments')) return;

    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

    const whenText = c => {
        const w = c.when;
        if (!w) return '';
        const d = w.date ? new Date(`${w.date}T${w.time || '12:00'}:00`).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', ...(w.time ? { hour: 'numeric', minute: '2-digit' } : {}) }) : '';
        return d || (w.time ? `at ${w.time}` : '');
    };
    const repeatText = c => !Commitments.repeats(c) ? undefined
        : c.repeat.rule === 'weekly' || c.repeat.rule === 'custom' ? `${c.repeat.rule} on ${c.repeat.days.map(d => DAYS[d]).join(', ')}` : c.repeat.rule;
    const brief = (c, today) => ({
        id: c.id, title: c.title, state: c.state,
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
        from: c.origin && c.origin.kind !== 'you' ? c.origin.kind : undefined
    });

    // The model's field names → the record's (C2: the words become fields;
    // C1: Commitments.vetFields checks every one).
    const FIELD_PROPS = {
        title: { type: 'string' },
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
        state: { type: 'string', enum: ['open', 'someday'] }
    };
    const toInput = (a, current = null) => {
        const x = {};
        const has = k => Object.prototype.hasOwnProperty.call(a, k);
        for (const k of ['title', 'note', 'outcome', 'state']) if (has(k)) x[k] = a[k];
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
        return x;
    };
    // What an approval shows (2026-10-04): the facts as the person would say
    // them (a day and a clock time, the bigger commitment's title, never an
    // id or a raw field name), as label / value rows. Spans, since the card
    // puts this inside a paragraph.
    const dayText = iso => { const d = Commitments.day(iso); return d ? new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : String(iso || ''); };
    const clock = t => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? new Date(2000, 0, 1, +m[1], +m[2]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : String(t || ''); };
    const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
    const factRows = (a) => {
        const has = k => Object.prototype.hasOwnProperty.call(a, k) && a[k] !== undefined;
        const rows = [];
        if (has('title') && a.title) rows.push(['Rename to', a.title]);
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
        if (has('outcome') && a.outcome) rows.push(['Done looks like', a.outcome]);
        if (has('state')) rows.push(['Status', a.state === 'someday' ? 'Someday' : 'Open']);
        if (has('note') && a.note) { const n = String(a.note).replace(/\s+/g, ' ').trim(); rows.push(['Note', n.length > 220 ? n.slice(0, 219).trimEnd() + '…' : n]); }
        return rows;
    };
    const factsHtml = rows => rows.length ? `<span class="agent-ask-facts">${rows.map(([k, v]) => `<span class="agent-ask-fact"><span class="agent-ask-fact-k">${esc(k)}</span><span class="agent-ask-fact-v">${esc(v)}</span></span>`).join('')}</span>` : '';
    const fieldsHtml = (a) => factsHtml(factRows(a));
    const titleOf = id => (Commitments.get(id) || {}).title || id;
    const opts = { group: 'commitments', blockUntrusted: true };
    AgentTools.GROUP_INFO.commitments = 'THE tools for the person\'s tasks, habits and projects (all are commitments): list, read, add, change, complete, move, plan a goal; use these first';
    // The old task / project tools still work (the bridge takes their writes
    // in), but the commitment tools carry steps, the assistant's reads and
    // code-computed dates, and always ask: the catalog points there first
    // (docs/COMMITMENTS.md phase 5). Routines and specialists that name the
    // old tools keep working.
    AgentTools.GROUP_INFO.schedule = 'older task tools (prefer commitments): create, change, reschedule and complete tasks';
    AgentTools.GROUP_INFO.goals = 'older project tools (prefer commitments): projects and their reviews';

    // A chat tied to a commitment is told where it stands NOW, every turn
    // (2026-10-05). Without it a chat continued the next day trusted its own
    // "moved to tomorrow" from the day before and said "It's set for 9:00 AM
    // tomorrow" having changed nothing. Read fresh by code, never recalled.
    if (typeof AgentContext !== 'undefined' && AgentContext.registerRecord) {
        AgentContext.registerRecord('task', (id) => {
            const c = Commitments.get(String(id || ''));
            if (!c) return null;
            const lines = Commitments.standing(c, Commitments.today(), c.parent ? titleOf(c.parent) : '');
            return {
                recordKey: 'task:' + c.id,
                recordLabel: c.title || '(untitled)',
                title: 'THIS CHAT\'S COMMITMENT',
                body: `This chat is about the commitment below. The app read these lines just now: they are where it stands at this moment, and they win over anything earlier in this chat, which may be from another day.

${lines.join('\n')}

When the person says when they will do it, compare the day they mean (counted from today) with the lines above. If it is a different day or time, it has NOT been moved yet. For a repeating one, a new time for ONE day ("just today", "this week only", "not permanently") is move_one_day with this id: the repeat and its usual time stay as they are. change_commitment changes it for good, every time it repeats. Say it is set, moved or done only when a tool call in THIS turn made it so, or when the lines above already show exactly that.`
            };
        });
    }

    AgentTools.register({ type: 'function', function: {
        name: 'list_commitments',
        description: 'The person\'s commitments: everything they said they would do, from small tasks and repeating habits to big outcomes (what used to be projects) and their steps. Filter by words, state, parent or a date window.',
        parameters: { type: 'object', properties: {
            search: { type: 'string', description: 'Words in the title or notes' },
            state: { type: 'string', enum: ['open', 'done', 'dropped', 'someday', 'all'], description: 'Default open' },
            parent: { type: 'string', description: 'Only the steps of this commitment (id)' },
            top_level: { type: 'boolean', description: 'Only commitments with no parent (the big ones and loose tasks)' },
            from: { type: 'string', description: 'YYYY-MM-DD: only ones happening or due on/after' },
            to: { type: 'string', description: 'YYYY-MM-DD: only ones happening or due on/before' }
        } }
    }}, (a = {}) => {
        const today = Commitments.today();
        let list = Commitments.all();
        const st = a.state || 'open';
        if (st !== 'all') list = list.filter(c => c.state === st);
        if (a.parent) list = list.filter(c => c.parent === a.parent);
        if (a.top_level) list = list.filter(c => !c.parent);
        if (a.search) { const q = String(a.search).toLowerCase(); list = list.filter(c => `${c.title} ${c.note} ${c.outcome || ''} ${(c.tags || []).join(' ')}`.toLowerCase().includes(q)); }
        const from = Commitments.day(a.from), to = Commitments.day(a.to);
        if (from || to) list = list.filter(c => {
            const d = Commitments.repeats(c) ? Commitments.nextOn(c, from || today) : (c.when && c.when.date) || c.by;
            return d && (!from || d >= from) && (!to || d <= to);
        });
        const key = c => (Commitments.repeats(c) ? Commitments.nextOn(c, today) : (c.when && c.when.date) || c.by) || '9999';
        list.sort((x, y) => key(x).localeCompare(key(y)) || x.title.localeCompare(y.title));
        return { today, count: list.length, items: list.slice(0, 60).map(c => brief(c, today)), ...(list.length > 60 ? { note: `Showing 60 of ${list.length}; narrow with search, parent or dates.` } : {}) };
    }, { ...opts, readOnly: true });

    AgentTools.register({ type: 'function', function: {
        name: 'get_commitment',
        description: 'One commitment in full: its facts, its notes, its steps (for a big one), what it belongs to, recent history, where it came from, and the matter it is a step of.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }}, (a = {}) => {
        const c = Commitments.get(String(a.id || ''));
        if (!c) return { error: 'No commitment with that id. Call list_commitments for ids.' };
        const today = Commitments.today();
        const hist = Object.entries(c.history || {}).sort(([x], [y]) => y.localeCompare(x)).slice(0, 14).map(([d, h]) => `${d} ${h}`);
        let matter;
        try { if (c.origin && c.origin.kind === 'matter' && typeof Matters !== 'undefined') { const m = Matters.get(c.origin.ref); if (m) matter = { id: m.id, title: Matters.titleOf(m), status: Matters.stepText(m) || m.state }; } } catch { /* optional */ }
        return {
            ...brief(c, today), note: c.note || undefined, outcome: c.outcome || undefined,
            remind: c.remind || undefined, origin: c.origin, history: hist.length ? hist : undefined,
            steps: Commitments.children(c.id).map(k => brief(k, today)),
            matter, createdAt: c.createdAt, updatedAt: c.updatedAt
        };
    }, { ...opts, readOnly: true });

    AgentTools.register({ type: 'function', function: {
        name: 'add_commitment',
        description: 'Add something the person said they would do. Fill in only what they said or clearly meant: a date, a time, a repeat, a reminder, what bigger commitment it belongs to (parent). A big outcome ("run a 10K by October") is a commitment with an outcome and a "by" date; its steps are commitments with it as parent.',
        parameters: { type: 'object', properties: FIELD_PROPS, required: ['title'] }
    }}, (a = {}) => {
        const r = Commitments.create(toInput(a), { by: 'assistant' });
        if (!r.ok) return { error: r.error };
        return { success: true, id: r.id, item: brief(Commitments.get(r.id), Commitments.today()), ...(r.dropped.length ? { notSet: r.dropped, why: 'Those fields were not valid and were left out.' } : {}) };
    }, { ...opts, ask: true, describe: (a) => `Add <b>${esc(a.title)}</b>${fieldsHtml({ ...a, title: undefined })}` });

    AgentTools.register({ type: 'function', function: {
        name: 'change_commitment',
        description: 'Change a commitment\'s facts: title, notes, date or time, repeat, reminder, deadline, what it belongs to, who it is waiting on, or put it to someday. Give only the fields that change. On a repeating one a new time or date changes EVERY occurrence from now on; for one day only use move_one_day.',
        parameters: { type: 'object', properties: { id: { type: 'string' }, ...FIELD_PROPS }, required: ['id'] }
    }}, (a = {}) => {
        const c = Commitments.get(String(a.id || ''));
        if (!c) return { error: 'No commitment with that id. Call list_commitments for ids.' };
        const r = Commitments.change(c.id, toInput(a, c), { by: 'assistant' });
        if (!r.ok) return { error: r.error };
        return { success: true, changed: r.changed, item: brief(Commitments.get(c.id), Commitments.today()), ...(r.dropped.length ? { notSet: r.dropped } : {}), ...(r.changed.length ? {} : { note: 'Nothing changed: it already was that way.' }) };
    }, { ...opts, ask: true, describe: (a) => `Change <b>${esc(titleOf(a.id))}</b>${fieldsHtml({ ...a, id: undefined })}` });

    // One day of a repeat at another time, that day only (2026-10-05). "Not
    // permanently, just for today" had no tool: the model reached for the
    // old task tool, which rewrote the whole series, and said it had not.
    AgentTools.register({ type: 'function', function: {
        name: 'move_one_day',
        description: 'Give ONE day of a repeating commitment another time, for that day only ("just today", "this week only", "not permanently", "I\'ll do today\'s in the evening"). The repeat and its usual time are untouched, so every other day stays as it was. The day stays the same; only its time changes. time "" puts that day back to its usual time. To skip a day use resolve_commitment with dropped.',
        parameters: { type: 'object', properties: {
            id: { type: 'string' },
            date: { type: 'string', description: 'YYYY-MM-DD, the day of it to move (today or later; it must be a day it happens). Default: its next day.' },
            time: { type: 'string', description: 'HH:MM (24h) start time for that day; "" for its usual time' },
            end: { type: 'string', description: 'HH:MM end time for that day; left out, the usual length is kept' }
        }, required: ['id', 'time'] }
    }}, (a = {}) => {
        const c = Commitments.get(String(a.id || ''));
        if (!c) return { error: 'No commitment with that id. Call list_commitments for ids.' };
        const r = Commitments.moveDay(c.id, { day: a.date || null, time: a.time || null, end: a.end || null }, { by: 'assistant' });
        if (!r.ok) return { error: r.error };
        const w = c.when || {};
        return { success: true, day: r.day, time: r.time, end: r.end || undefined,
            thatDayOnly: r.moved, usualTime: w.time || undefined, repeat: repeatText(c),
            note: r.changed.length ? (r.moved ? 'Only this day moved. Every other day keeps the usual time.' : 'This day is back at its usual time.') : 'Nothing changed: that day already was at that time.' };
    }, { ...opts, ask: true, describe: (a) => {
        const c = Commitments.get(String(a.id || ''));
        const day = c ? (Commitments.day(a.date) || Commitments.nextOn(c, Commitments.today())) : Commitments.day(a.date);
        const usual = c && c.when && c.when.time ? clock(c.when.time) : '';
        const rows = a.time
            ? [['When', `${day ? dayText(day) : 'Its next day'}, ${clock(a.time)}${a.end ? ` to ${clock(a.end)}` : ''}`], ['Applies to', `That day only${usual ? ` (the usual time stays ${usual})` : ''}`]]
            : [['When', `${day ? dayText(day) : 'Its next day'}, back to ${usual || 'its usual time'}`]];
        return `Move one day of <b>${esc(titleOf(a.id))}</b>${factsHtml(rows)}`;
    } });

    AgentTools.register({ type: 'function', function: {
        name: 'resolve_commitment',
        description: 'Mark a commitment done, or dropped (the person is deliberately not doing it; the app calls this Ignore), or reopen it. For a repeating one this is for that day only. Not needed when the person, in that commitment\'s own chat, simply tells you how a day of it went ("did it today", "skipped Monday"): the app files their words on that day itself and shows a receipt.',
        parameters: { type: 'object', properties: {
            id: { type: 'string' }, how: { type: 'string', enum: ['done', 'dropped', 'reopen'] },
            date: { type: 'string', description: 'YYYY-MM-DD, default today (repeating ones)' }
        }, required: ['id', 'how'] }
    }}, (a = {}) => {
        const c = Commitments.get(String(a.id || ''));
        if (!c) return { error: 'No commitment with that id. Call list_commitments for ids.' };
        const r = a.how === 'reopen' ? Commitments.reopen(c.id, { by: 'assistant', date: a.date }) : Commitments.resolve(c.id, a.how, { by: 'assistant', date: a.date });
        if (!r.ok) return { error: r.error };
        return { success: true, item: brief(Commitments.get(c.id), Commitments.today()), ...(r.changed.length ? {} : { note: 'Already that way; nothing changed.' }) };
    }, { ...opts, ask: true, describe: (a) => `${a.how === 'done' ? 'Mark done' : a.how === 'dropped' ? 'Ignore' : 'Reopen'}: <b>${esc(titleOf(a.id))}</b>${a.date ? ` (${esc(dayText(a.date))})` : ''}` });

    AgentTools.register({ type: 'function', function: {
        name: 'remove_commitment',
        description: 'Delete a commitment for good (prefer resolve_commitment with dropped when the person is just not doing it). Its steps are kept and move up a level.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }}, (a = {}) => {
        const r = Commitments.remove(String(a.id || ''), { by: 'assistant' });
        return r.ok ? { success: true, movedSteps: r.movedChildren.length } : { error: r.error };
    }, { ...opts, ask: true, describe: (a) => `Delete <b>${esc(titleOf(a.id))}</b>${Commitments.children(a.id).length ? ` (its ${Commitments.children(a.id).length} steps are kept)` : ''}` });

    AgentTools.register({ type: 'function', function: {
        name: 'plan_outcome',
        description: 'Plan a bigger commitment (an outcome the person is working toward) WITH them: call this first, then have the conversation. It returns what is already known (the outcome, the deadline, the steps there are, what the person has told you before) and what is still missing. Ask only for what is missing, one question at a time, then propose the steps with dates and add each with add_commitment (parent = this id) once they agree. For a NEW goal, first add it with add_commitment (title, outcome and by if they said), then call this with its id.',
        parameters: { type: 'object', properties: {
            id: { type: 'string', description: 'The commitment to plan (from list_commitments or add_commitment)' }
        }, required: ['id'] }
    }}, (a = {}) => {
        const c = a.id ? Commitments.get(String(a.id)) : null;
        if (!c) return { error: 'No commitment with that id. Add the goal with add_commitment first, or find it with list_commitments.' };
        const today = Commitments.today();
        const steps = Commitments.children(c.id).map(k => brief(k, today));
        const missing = [];
        if (!c.outcome) missing.push('what done looks like (one concrete sentence)');
        if (!c.by) missing.push('by when');
        if (!steps.filter(s => s.state === 'open').length) missing.push('the first steps (propose 3 to 6, each with a day)');
        let known = [];
        try { if (typeof MemoryManager !== 'undefined') known = MemoryManager.all().filter(f => ['about', 'preferences', 'plans'].includes(f.heading)).slice(0, 15).map(f => f.text); } catch { known = []; }
        return {
            id: c.id, title: c.title, outcome: c.outcome || undefined, by: c.by || undefined, today, steps,
            missing: missing.length ? missing : ['nothing essential: check the steps still fit and offer the next one'],
            whatYouKnow: known.length ? known : undefined,
            how: 'Ask only what is missing, one short question at a time. Then propose the steps as a short list with days and add them with add_commitment(parent=' + c.id + ') when the person agrees. Save the outcome or deadline with change_commitment.'
        };
    }, { ...opts, readOnly: true });

    /**
     * The dates a move would give (C1: code computes them). Pure over the
     * store. One-time, open, dated commitments only; a repeat moves its start.
     */
    const movePlan = (a) => {
        let list = Commitments.all().filter(c => c.state === 'open' && c.when && c.when.date);
        if (Array.isArray(a.ids) && a.ids.length) { const s = new Set(a.ids.map(String)); list = list.filter(c => s.has(c.id)); }
        else if (a.parent) list = list.filter(c => c.parent === a.parent);
        else if (!a.all) return { error: 'Say which: ids, parent, or all:true.' };
        const from = Commitments.day(a.date_from), to = Commitments.day(a.date_to);
        if (from) list = list.filter(c => c.when.date >= from);
        if (to) list = list.filter(c => c.when.date <= to);
        if (!list.length) return { error: 'Nothing dated and open in that scope.' };
        let shift = Number(a.shift_days);
        const anchor = Commitments.day(a.anchor_date);
        if (anchor) {
            const first = list.map(c => c.when.date).sort()[0];
            shift = Math.round((Date.parse(`${anchor}T12:00:00`) - Date.parse(`${first}T12:00:00`)) / 86400000);
        }
        if (!Number.isFinite(shift) || (shift === 0 && !a.collapse)) return { error: 'Give shift_days (not 0) or anchor_date.' };
        const add = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return Commitments.iso(x); };
        const moves = list.map(c => ({ id: c.id, title: c.title, from: c.when.date, to: a.collapse && anchor ? anchor : add(c.when.date, shift) }));
        return { moves, shift };
    };
    AgentTools.register({ type: 'function', function: {
        name: 'move_commitments',
        description: 'Move the dates of many commitments at once; the app computes every new date and keeps their spacing. Scope: ids, parent (all steps of a big commitment), or all:true bounded by date_from/date_to. Amount: shift_days (relative, "push out a week" = 7), or anchor_date (the earliest lands there, the rest keep spacing); collapse:true with anchor_date puts every one on that day ("move the overdue to today"). The person approves the exact list first.',
        parameters: { type: 'object', properties: {
            ids: { type: 'array', items: { type: 'string' } }, parent: { type: 'string' }, all: { type: 'boolean' },
            date_from: { type: 'string' }, date_to: { type: 'string' },
            shift_days: { type: 'number' }, anchor_date: { type: 'string' }, collapse: { type: 'boolean' }
        } }
    }}, (a = {}) => {
        const p = movePlan(a);
        if (p.error) return { error: p.error };
        const ledger = [];
        for (const m of p.moves) {
            const c = Commitments.get(m.id);
            const r = Commitments.change(m.id, { when: { ...c.when, date: m.to } }, { by: 'assistant', why: 'move_commitments' });
            if (r.ledgerId) ledger.push(r.ledgerId);
        }
        return { success: true, moved: p.moves.length, first: p.moves.map(m => m.to).sort()[0], last: p.moves.map(m => m.to).sort().slice(-1)[0] };
    }, { ...opts, ask: true, describe: (a) => {
        const p = movePlan(a);
        if (p.error) return esc(p.error);
        return `Move <b>${p.moves.length}</b> commitment${p.moves.length === 1 ? '' : 's'}${factsHtml([...p.moves.slice(0, 12).map(m => [m.title, `${dayText(m.from)} → ${dayText(m.to)}`]), ...(p.moves.length > 12 ? [['', `and ${p.moves.length - 12} more`]] : [])]).replace('agent-ask-facts', 'agent-ask-facts is-list')}`;
    } });
})();
