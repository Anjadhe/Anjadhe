/**
 * Wellness — the package's contribution to the assistant.
 *
 * Everything the assistant knows about the health log is registered HERE,
 * from the app's own folder, through the seams every app package uses
 * (docs/PLATFORM.md "App packages: one container, two trust tiers"):
 *
 *   AgentTools.register(def, handler, opts) — the five tools, each carrying
 *     its own policy: ask-before-run, untrusted-turn block, cloud-privacy
 *     data class, consent-dialog line, navigation-pill record kind.
 *   AgentTools.registerDomain('wellness', RegExp) — the words that summon
 *     the group into the prompt (_domainsForMessage tests it every turn).
 *   GlobalSearch.registerSource('wellness', …) — ⌘K and search_all.
 *
 * Nothing in js/agent/ or js/core/ names wellness for any of the above; if
 * this file is not loaded, the assistant simply has no health log — which
 * is the "not installed" state the packaging is for. The ambient context
 * provider (AgentContext.register) stays in wellness-app.js beside the
 * summary it reads.
 *
 * Loads AFTER the assistant stack (index.html: below agent-ui.js) because
 * registration writes into PermissionManager / AgentService / WriteLedger /
 * CloudPrivacy tables that must already exist. The handlers are reachable
 * as AgentTools.handlers.<name> exactly as before (the evals rely on it).
 */

(function registerWellnessTools() {
    if (typeof AgentTools === 'undefined' || typeof WellnessApp === 'undefined') return;

    const SOURCE = 'wellness';
    const KIND_LIST = Object.keys(WellnessApp.KINDS);

    /**
     * Normalize an entry time: accept "YYYY-MM-DD HH:MM", ISO, or a bare
     * date. Returns YYYY-MM-DDTHH:MM (dateOnly kinds pinned to T07:00) or
     * null when the string can't be read. ONE path for log AND update —
     * the rules must not drift between create and correct.
     */
    function normalizeTime(spec, raw) {
        let time = typeof raw === 'string' ? raw.trim().replace(' ', 'T') : '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(time)) time += spec.dateOnly ? 'T07:00' : 'T12:00';
        time = time.slice(0, 16);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time)) return null;
        if (spec.dateOnly) time = time.slice(0, 10) + 'T07:00';
        return time;
    }

    /**
     * Coerce a kind's field args into entry values (number coercion, 1-5
     * segment clamp, units), folding unconsumed TEXT args into notes when
     * the kind has a notes field. Details the user said must never be
     * silently dropped (the strength-workout report: exercises passed in a
     * wrong-but-present param vanished because it wasn't in this kind's
     * field list) — a detail in the wrong pocket beats no detail.
     */
    function fieldValues(spec, args) {
        const values = {};
        for (const f of spec.fields) {
            let v = args[f.id];
            if (v == null || v === '') continue;
            if (f.type === 'number' || f.type === 'segment') {
                v = Number(v);
                if (isNaN(v)) continue;
                if (f.type === 'segment') v = Math.min(5, Math.max(1, Math.round(v)));
            } else {
                v = String(v);
            }
            values[f.id] = v;
            if (f.unitKey) values.unit = WellnessApp.unitFor(f.unitKey);
        }
        const hasNotes = spec.fields.some(f => f.id === 'notes');
        if (hasNotes) {
            const consumed = new Set(spec.fields.map(f => f.id));
            const stray = ['description', 'context', 'name', 'dose']
                .filter(k => !consumed.has(k))
                .map(k => (typeof args[k] === 'string' ? args[k].trim() : ''))
                .filter(Boolean);
            if (stray.length) {
                values.notes = [values.notes, ...stray].filter(Boolean).join(' — ');
            }
        }
        return values;
    }

    /** Repaint the log if the user is looking at it. */
    function refresh() {
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'wellness') {
            WellnessApp.loadData();
            WellnessApp.render();
        }
    }

    function bpCategory(entry) {
        return WellnessApp.categorizeBp(Number(entry.systolic), Number(entry.diastolic)).label;
    }

    const esc = (v) => (typeof UIUtils !== 'undefined' ? UIUtils.escapeHtml(String(v == null ? '' : v)) : String(v == null ? '' : v));

    // ── The words that summon the group ────────────────────────────────
    AgentTools.registerDomain(SOURCE,
        /\b(wellness|health|blood\s?pressure|bp|systolic|diastolic|pulses?|heart\s?rate|bpm|weight|weigh(ed|ing)?|glucose|blood\s?sugar|spo2|oxygen|temperatures?|fever|sleep|slept|hydration|water|meals?|ate|eating|medications?|meds?|vitamins?|supplements?|symptoms?|headaches?|workouts?|exercis\w+|breath\w+|steps|mood)\b/);

    // ── Tools ──────────────────────────────────────────────────────────
    const record = { app: SOURCE, key: 'entry', label: 'Wellness' };

    AgentTools.register({ type: 'function', function: {
        name: 'log_wellness',
        description: 'Log a health entry in the Wellness app. kind decides which fields apply: bp (systolic, diastolic, pulse) · pulse = resting heart rate (value) · glucose (value, context) · spo2 (value %) · temperature (value) · weight (value) · activity (activityType, duration min, avgBpm, maxBpm) · steps (value) · meal (mealType, description) · water (amount) · sleep (hours, quality 1-5) · mood (mood/energy/stress 1-5) · medication (name, dose) · symptom (name, severity 1-5) · note (notes). EVERY kind also takes `notes` — put every specific the user gave that has no field of its own there (the exercises in a strength workout, how a symptom developed, what changed): details the user said out loud must NEVER be dropped. Log meals/activities BEFORE a bp/glucose reading so the reading gets timing context. FOLLOW-UPS: when the user adds to or corrects something already logged (a start time, a missed detail), call update_wellness on that entry — logging again would create a duplicate.',
        parameters: { type: 'object', properties: {
            kind: { type: 'string', enum: KIND_LIST },
            time: { type: 'string', description: 'Local time YYYY-MM-DDTHH:MM (or YYYY-MM-DD for sleep). Default: now.' },
            systolic: { type: 'number' }, diastolic: { type: 'number' }, pulse: { type: 'number' },
            value: { type: 'number', description: 'The measurement, for kinds pulse/glucose/spo2/temperature/weight/steps' },
            context: { type: 'string', description: 'Glucose timing: Fasting, Before meal, After meal, Bedtime, Random' },
            mealType: { type: 'string', description: 'Breakfast, Lunch, Dinner, Snack, Drink' },
            description: { type: 'string', description: 'What was eaten' },
            activityType: { type: 'string', description: 'Walk, Run, Strength training, Suryanamaskar, Yoga, Mindful breathing, Cycling, Swim, Sport, Other' },
            duration: { type: 'number' }, avgBpm: { type: 'number' }, maxBpm: { type: 'number' },
            amount: { type: 'number', description: 'Water amount, in the user\'s water unit' },
            hours: { type: 'number' }, quality: { type: 'number' },
            mood: { type: 'number' }, energy: { type: 'number' }, stress: { type: 'number' },
            name: { type: 'string', description: 'Medication or symptom name' },
            dose: { type: 'string' }, severity: { type: 'number' },
            notes: { type: 'string', description: 'Free-text details, any kind: everything the user said that no other field holds — e.g. "bench press 3x8, squats 3x10, felt strong" on a strength-training activity. Never discard the user\'s specifics.' }
        }, required: ['kind'] }
    }}, (args) => {
        const kind = args.kind;
        const spec = WellnessApp.KINDS[kind];
        if (!spec) return { error: `Unknown kind "${kind}". Kinds: ${KIND_LIST.join(', ')}` };
        WellnessApp.loadData();

        const time = normalizeTime(spec, args.time) || normalizeTime(spec, WellnessApp.nowLocal());
        const values = Object.assign({ time }, fieldValues(spec, args));

        for (const f of spec.fields) {
            if (f.required && (values[f.id] == null || values[f.id] === '')) {
                return { error: `"${f.id}" is required for kind "${kind}"` };
            }
        }

        const entry = WellnessApp.addEntry(kind, values);
        refresh();
        const result = { success: true, entry };
        if (kind === 'bp') result.category = bpCategory(entry);
        return result;
    // log_wellness is NOT untrusted-blocked on purpose: a local reversible
    // write, and logging must keep working everywhere (WELLNESS_COACH.md W7).
    }, { source: SOURCE, group: SOURCE, record });

    AgentTools.register({ type: 'function', function: {
        name: 'update_wellness',
        description: 'Correct or extend an EXISTING Wellness entry. When the user follows up about something already logged — "actually I started at 11:20", "forgot to mention the chin ups", "it was 30 minutes, not 45" — update THAT entry; a correction is NEVER a second log_wellness call (that creates a duplicate). Pass the entry id from the log_wellness result earlier in this conversation, or find it with list_wellness. Fields you pass REPLACE the old values: when rewriting notes, include everything that should remain, not just the new detail. The entry\'s kind cannot change — delete and re-log for that.',
        parameters: { type: 'object', properties: {
            id: { type: 'string', description: 'The entry id (from log_wellness or list_wellness)' },
            time: { type: 'string', description: 'Corrected local time YYYY-MM-DDTHH:MM' },
            systolic: { type: 'number' }, diastolic: { type: 'number' }, pulse: { type: 'number' },
            value: { type: 'number' }, context: { type: 'string' },
            mealType: { type: 'string' }, description: { type: 'string' },
            activityType: { type: 'string' },
            duration: { type: 'number' }, avgBpm: { type: 'number' }, maxBpm: { type: 'number' },
            amount: { type: 'number' }, hours: { type: 'number' }, quality: { type: 'number' },
            mood: { type: 'number' }, energy: { type: 'number' }, stress: { type: 'number' },
            name: { type: 'string' }, dose: { type: 'string' }, severity: { type: 'number' },
            notes: { type: 'string', description: 'The FULL notes text as it should read after the correction' }
        }, required: ['id'] }
    }}, (args) => {
        WellnessApp.loadData();
        const existing = WellnessApp.entries.find(e => e.id === args.id);
        if (!existing) return { error: `No wellness entry with id "${args.id}". Find the id with list_wellness.` };
        const spec = WellnessApp.KINDS[existing.kind];
        if (!spec) return { error: `Entry has unknown kind "${existing.kind}"` };

        const values = fieldValues(spec, args);
        // A misfiled detail folded into notes is NEW text — append it to
        // what the entry already says rather than silently replacing it.
        // An explicit notes arg replaces (its description says to pass
        // the full corrected text).
        if (values.notes != null && args.notes == null && existing.notes) {
            values.notes = existing.notes + ' — ' + values.notes;
        }
        if (args.time != null && args.time !== '') {
            const time = normalizeTime(spec, args.time);
            if (!time) return { error: 'time must be YYYY-MM-DDTHH:MM (or YYYY-MM-DD)' };
            values.time = time;
        }
        if (!Object.keys(values).length) return { error: 'Nothing to change — pass time or the fields to correct' };

        const entry = WellnessApp.updateEntry(existing.id, values);
        refresh();
        const result = { success: true, entry };
        if (entry.kind === 'bp') result.category = bpCategory(entry);
        return result;
    }, { source: SOURCE, group: SOURCE, record, blockUntrusted: true });

    AgentTools.register({ type: 'function', function: {
        name: 'delete_wellness',
        description: 'Delete one Wellness entry by id (from list_wellness) — e.g. removing a duplicate. The user is asked to confirm.',
        parameters: { type: 'object', properties: {
            id: { type: 'string' }
        }, required: ['id'] }
    }}, (args) => {
        WellnessApp.loadData();
        const entry = WellnessApp.entries.find(e => e.id === args.id);
        if (!entry) return { error: `No wellness entry with id "${args.id}". Find the id with list_wellness.` };
        WellnessApp.deleteEntry(args.id);
        refresh();
        return { success: true, deleted: { id: entry.id, kind: entry.kind, time: entry.time } };
    }, {
        source: SOURCE, group: SOURCE, ask: true, blockUntrusted: true,
        // Name the entry so "delete a wellness entry" reads as the specific
        // reading/workout going, not a raw id.
        describe(args) {
            let e = null;
            try {
                WellnessApp.loadData();
                e = WellnessApp.entries.find(x => x.id === args.id) || null;
            } catch (_) {}
            const label = e ? (WellnessApp.KINDS[e.kind]?.label || e.kind) : null;
            return `Delete the wellness entry <strong>${esc(label || args.id || 'Unknown')}</strong>` +
                   (e?.time ? ` from ${esc(String(e.time).replace('T', ' '))}` : '') + '.';
        }
    });

    AgentTools.register({ type: 'function', function: {
        name: 'list_wellness',
        description: 'List Wellness health entries, newest first. Blood pressure and glucose entries include the last meal and activity logged before them (with minutes elapsed) plus a BP category. Kinds: ' + KIND_LIST.join(', ') + '.',
        parameters: { type: 'object', properties: {
            kind: { type: 'string', description: 'Filter to one kind (omit for all)' },
            date_from: { type: 'string', description: 'YYYY-MM-DD' },
            date_to: { type: 'string', description: 'YYYY-MM-DD' },
            limit: { type: 'number', description: 'Max entries to return (default 20)' }
        }}
    }}, (args = {}) => {
        WellnessApp.loadData();
        let entries = WellnessApp.sorted(args.kind && WellnessApp.KINDS[args.kind] ? args.kind : null);
        if (args.date_from) entries = entries.filter(e => e.time.slice(0, 10) >= args.date_from);
        if (args.date_to) entries = entries.filter(e => e.time.slice(0, 10) <= args.date_to);
        entries = entries.reverse().slice(0, Math.max(1, Math.min(100, args.limit || 20)));

        return {
            totalMatching: entries.length,
            units: WellnessApp.settings.units,
            entries: entries.map(e => {
                const out = Object.assign({}, e);
                if (e.kind === 'bp') out.category = bpCategory(e);
                // Timing context makes bp/glucose numbers interpretable.
                if (e.kind === 'bp' || e.kind === 'glucose') {
                    const ctx = WellnessApp.contextBefore(e.time);
                    out.lastMealBefore = ctx.lastMeal ? Object.assign({}, ctx.lastMeal, {
                        minutesBeforeReading: WellnessApp.minutesBetween(ctx.lastMeal.time, e.time)
                    }) : null;
                    out.lastActivityBefore = ctx.lastActivity ? Object.assign({}, ctx.lastActivity, {
                        minutesBeforeReading: WellnessApp.minutesBetween(ctx.lastActivity.time, e.time)
                    }) : null;
                }
                return out;
            })
        };
    }, { source: SOURCE, group: SOURCE, blockUntrusted: true, dataClass: 'wellness' });

    AgentTools.register({ type: 'function', function: {
        name: 'wellness_summary',
        description: 'Wellness overview: latest blood pressure with category, 7/30-day BP averages, latest weight (with delta), latest glucose, last sleep, water today, mood today, and totals. Call this first for broad health questions.',
        parameters: { type: 'object', properties: {} }
    }}, () => {
        WellnessApp.loadData();
        // trends are COMPUTED (WELLNESS_COACH.md W1) — the coach routines
        // are told to use these numbers, never their own math.
        return Object.assign({ units: WellnessApp.settings.units },
            WellnessApp.summary(),
            { trends: WellnessApp.trends() });
    }, { source: SOURCE, group: SOURCE, blockUntrusted: true, dataClass: 'wellness' });

    // ── Search (⌘K + search_all) ───────────────────────────────────────
    if (typeof GlobalSearch !== 'undefined') {
        GlobalSearch.registerSource(SOURCE, {
            label: 'Wellness',
            index(push, get) {
                for (const w of get('wellness', 'entries')) {
                    const text = [w.name, w.description, w.notes, w.activityType, w.mealType]
                        .filter(Boolean).join(' ');
                    const label = `${w.kind}: ${(w.name || w.description || w.notes || w.activityType || '').slice(0, 60)}`;
                    push(w.id, label, text, { meta: { kind: w.kind, time: w.time } });
                }
            }
            // No per-entry page exists; the log itself is the destination
            // (the default open).
        });
    }
})();
