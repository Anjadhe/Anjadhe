/**
 * Record types — the ONE table of "kinds of record a chat can be about".
 *
 * Five surfaces used to each keep their own copy of this list: @-mention
 * candidates (RecordMention._index + TYPE_WORDS), decision keys
 * (DecisionStore.TYPES / resolveKey / fromRecordKey / pruneOrphans), the
 * conversation banner's label and click target (AgentUI._recordTypeLabel /
 * _openRecordFromKey), the "Open <type>" pill after save_decision, and the
 * save_decision tool's `type` enum. They agreed only by discipline, and an
 * app package could join none of them. Now each reads this registry, and a
 * package registers its types from its own folder (docs/PLATFORM.md "App
 * packages" — Portfolio's strategy / account / ticker were the first).
 *
 * A type definition:
 *   type        'strategy' — the decision-key prefix and the tool enum value
 *   label       'Strategy' — what the UI calls one
 *   plural      'strategies'
 *   words       ['strategy', 'strategies'] — @-mention filter words
 *   app         AppManager id that owns the record
 *   recordKey   (id) => AgentContext recordKey ('portfolio:strategy:<id>')
 *   match       RegExp with one capture over a recordKey → the id
 *   index       () => [{ id, title, sub, body, recency }] — mention rows
 *               (omit or return [] for a type nobody @-mentions)
 *   resolve     ({ id, name }) => { id, title } | null — validates a record
 *               for save_decision; name lookup optional
 *   ids         () => Set<string> | null — live ids for orphan pruning
 *               (null = unknowable right now, never prune)
 *   open        (id) => void — navigate to the record (never mutate)
 *   decisions   false → not a decision host (ticker pages); default true
 *
 * The built-ins are seeded below in the order the UI lists them.
 */

const RecordTypes = {
    _defs: new Map(),

    register(type, def) {
        if (!/^[a-z][a-z0-9-]{0,30}$/.test(String(type || '')) || !def || typeof def.recordKey !== 'function' || !(def.match instanceof RegExp)) {
            console.warn('[record-types] register needs a type, recordKey(id) and a match RegExp', type);
            return false;
        }
        this._defs.set(type, {
            type,
            label: def.label || type,
            plural: def.plural || (def.label || type).toLowerCase() + 's',
            words: Array.isArray(def.words) ? def.words.map(w => String(w).toLowerCase()) : [type],
            app: def.app || null,
            recordKey: def.recordKey,
            match: def.match,
            index: typeof def.index === 'function' ? def.index : null,
            resolve: typeof def.resolve === 'function' ? def.resolve : null,
            ids: typeof def.ids === 'function' ? def.ids : () => null,
            open: typeof def.open === 'function' ? def.open : null,
            decisions: def.decisions !== false
        });
        // The decision tools' `type` enum is a static definition built at
        // load; a type registered later joins it in place so the model is
        // offered it.
        if (this._defs.get(type).decisions && typeof AgentTools !== 'undefined') {
            for (const name of ['save_decision', 'list_decisions', 'delete_decision']) {
                const d = AgentTools.definitions?.find(x => x.function?.name === name);
                const en = d?.function?.parameters?.properties?.type?.enum;
                if (Array.isArray(en) && !en.includes(type)) en.push(type);
            }
        }
        return true;
    },

    unregister(type) { this._defs.delete(type); },

    get(type) { return this._defs.get(String(type || '').toLowerCase()) || null; },

    /** Every definition, registration order. */
    all() { return [...this._defs.values()]; },

    /** Types that host decisions (the save_decision vocabulary). */
    decisionTypes() { return this.all().filter(d => d.decisions).map(d => d.type); },

    /** Types the @-mention popover offers. */
    mentionable() { return this.all().filter(d => d.index !== null); },

    /** '@goal' / '@goals' → 'Goal' (the label, which is what rows carry). */
    words() {
        const out = {};
        for (const d of this.all()) for (const w of d.words) out[w] = d.label;
        return out;
    },

    /** A recordKey → { type, id, def } or null. */
    fromRecordKey(recordKey) {
        const rk = String(recordKey || '');
        for (const d of this.all()) {
            const m = d.match.exec(rk);
            if (m) return { type: d.type, id: m[1], def: d };
        }
        return null;
    },

    /** '<type>:<id>' (a decision key) → the AgentContext recordKey, or null. */
    recordKey(type, id) {
        const d = this.get(type);
        return d ? d.recordKey(id) : null;
    },

    /** The banner word for a recordKey, or null when no type claims it. */
    labelFor(recordKey) {
        const hit = this.fromRecordKey(recordKey);
        return hit ? hit.def.label : null;
    }
};

// ── Built-in seeds ─────────────────────────────────────────────────────
// Lookups are lazy (read at call time) so this file needs nothing loaded
// before it. Each mirrors what the five surfaces used to hardcode.
(function seedBuiltins() {
    const blob = (key, field) => {
        const d = (typeof StorageManager !== 'undefined') ? StorageManager.get(key) : null;
        return Array.isArray(d?.[field]) ? d[field] : [];
    };
    const idsOf = (key, field) => {
        const d = (typeof StorageManager !== 'undefined') ? StorageManager.get(key) : null;
        const list = d ? d[field] : null;
        return Array.isArray(list) ? new Set(list.map(r => r && String(r.id)).filter(Boolean)) : null;
    };
    const byId = (key, field, id, label) => {
        const rec = blob(key, field).find(r => r && String(r.id) === String(id));
        return rec ? { id: rec.id, title: rec.title || label } : null;
    };
    const later = (fn) => setTimeout(fn, 0);

    RecordTypes.register('goal', {
        label: 'Goal', plural: 'goals', words: ['goal', 'goals'], app: 'goals',
        recordKey: (id) => `goals:${id}`, match: /^goals:(.+)$/,
        index: () => blob('goals', 'goals').filter(g => g.status !== 'completed').map(g => ({
            id: g.id, title: g.title || '(untitled)', sub: g.group || g.targetDate || '', body: g.description || '',
            recency: g.modifiedAt || g.createdAt || '' })),
        resolve: ({ id }) => byId('goals', 'goals', id, 'goal'),
        ids: () => idsOf('goals', 'goals'),
        open: (id) => { AppManager.openApp('goals', false); later(() => typeof GoalsPage !== 'undefined' && GoalsPage.selectNode?.('goal', id)); }
    });

    RecordTypes.register('task', {
        label: 'Task', plural: 'tasks', words: ['task', 'tasks'], app: 'schedule',
        recordKey: (id) => `schedule:${id}`, match: /^schedule:(.+)$/,
        index: () => blob('schedule', 'scheduleItems').filter(s => (typeof AgentTools !== 'undefined' && AgentTools._isLiveTask)
                ? AgentTools._isLiveTask(s) : !s.lastCompletedDate)
            .map(s => ({ id: s.id, title: s.title || '(untitled)', sub: s.scheduledDate || '', body: s.description || '',
                recency: s.modifiedAt || s.createdAt || s.scheduledDate || '' })),
        resolve: ({ id }) => byId('schedule', 'scheduleItems', id, 'task'),
        ids: () => idsOf('schedule', 'scheduleItems'),
        open: (id) => { AppManager.openApp('schedule', false); later(() => typeof ScheduleApp !== 'undefined' && ScheduleApp.openEditor?.(id)); }
    });

    // Routines and plain notes are both notes under the hood — the
    // routine's recordKey is 'prompts:' (its own resolver), and feed posts
    // (machine-written routine output) are not mentionable.
    const noteTemplate = (n) => (typeof NoteTemplates !== 'undefined' && NoteTemplates.resolve) ? NoteTemplates.resolve(n) : n.template;

    RecordTypes.register('note', {
        label: 'Note', plural: 'notes', words: ['note', 'notes'], app: 'notes',
        recordKey: (id) => `notes:${id}`, match: /^notes:(.+)$/,
        index: () => blob('notes', 'notes').filter(n => { const t = noteTemplate(n); return t !== 'feed' && t !== 'prompt'; })
            .map(n => ({ id: n.id, title: n.title || '(untitled)', sub: '',
                body: (typeof AgentTools !== 'undefined' && AgentTools._noteText) ? AgentTools._noteText(n).slice(0, 400) : '',
                recency: n.modifiedAt || n.createdAt || '' })),
        resolve: ({ id }) => byId('notes', 'notes', id, 'note'),
        ids: () => idsOf('notes', 'notes'),
        open: (id) => { AppManager.openApp('notes', false); later(() => typeof NotesApp !== 'undefined' && NotesApp.openEditor?.(id, { focus: true })); }
    });

    RecordTypes.register('routine', {
        label: 'Routine', plural: 'routines', words: ['routine', 'routines'], app: 'prompts',
        recordKey: (id) => `prompts:${id}`, match: /^prompts:(.+)$/,
        index: () => blob('notes', 'notes').filter(n => noteTemplate(n) === 'prompt')
            .map(n => ({ id: n.id, title: n.title || '(untitled)', sub: '', body: '', recency: n.modifiedAt || n.createdAt || '' })),
        resolve: ({ id }) => byId('notes', 'notes', id, 'routine'),
        ids: () => idsOf('notes', 'notes'),   // a routine IS a prompt note
        open: (id) => { AppManager.openApp('prompts', false); later(() => typeof PromptsApp !== 'undefined' && PromptsApp.openPrompt?.(id)); }
    });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RecordTypes;
