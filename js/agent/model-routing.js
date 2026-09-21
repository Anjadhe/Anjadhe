/**
 * ModelRouting — which model answers which part of the app.
 *
 * The user keeps a LIST of model entries (AgentService.modelList) and marks
 * one the DEFAULT: the brain. Until 2026-09-16 the brain answered everything
 * — chat, email insights, news digests, document tidying, routines — so a
 * 27B picked for chat also spent thirty seconds per email, and a BYOK key
 * picked for quality also billed every ambient pass.
 *
 * A SURFACE is a part of the app the user can point at a different entry:
 * seven of them, each a bucket of LLMLogger source tags. An assignment is a
 * preference, never a dependency; the brain answers everything else.
 *
 * Laws (change rule: no patch without a law).
 *
 *   R1. An UNASSIGNED surface behaves exactly as before — same model, same
 *       routing, byte for byte. Absence is the default; nothing stores a
 *       copy of the brain, so changing the brain still moves everything the
 *       user never spoke about. `resolve().overrides` is false whenever the
 *       effective entry IS the brain, and LLMLogger leaves params alone.
 *
 *   R2. The USER assigns. The app never routes around a choice, never
 *       escalates to a bigger model, never falls back to another engine on
 *       failure — an assigned surface returns its own engine's error
 *       (docs/AI_ASSISTANT_DESIGN.md principle 1; the "no hybrid" law
 *       forbids the app choosing, not the user choosing).
 *
 *   R3. At most ONE local entry is in play across every surface. The
 *       llama.cpp manager holds one model at a time (llamacpp-manager.js
 *       ensureModel), so two local assignments would stop and respawn
 *       llama-server on every alternating call — multi-GB of weights per
 *       swap. `localInPlay` names the one, `resolve` coerces any other
 *       local assignment onto it (coercion stays LOCAL, which is the safe
 *       direction: it never sends data somewhere the user didn't pick),
 *       and the Settings picker refuses it up front.
 *
 *   R4. Routing decides the destination, and the DESTINATION decides the
 *       gates: whether this call leaves the Mac (CloudPrivacy), whether it
 *       is metered, whether it can see. Ask per surface, never of the
 *       brain — a gate that reads the brain while the work runs elsewhere
 *       is wrong in both directions (it blocks work that stays home, and
 *       it lets work leave unguarded).
 *
 *   R5. A dangling assignment — the entry was deleted — falls back to the
 *       brain silently. An assignment is a preference, not a dependency.
 *
 *   R6. Parallelism is a CONSEQUENCE, not a goal. Local jobs still queue
 *       behind each other in main's llmScheduler because local decode is
 *       memory-bandwidth-bound; what actually runs beside chat is a surface
 *       routed OFF this Mac (isLocalLLMJob → the gate opens at once).
 *       Never "parallelise" by assigning two local models.
 *
 * Pure over its inputs and pinned by tests/model-routing-test.js. The
 * renderer wiring is AgentService (entryForSurface / surfaceRouting) and
 * LLMLogger (the one seam every AI call passes through).
 */

const ModelRouting = {
    /** Where an assignment is stored inside the agent-settings blob. */
    KEY: 'modelRoutes',

    /**
     * Display order. `sources` are exact LLMLogger tags; `prefixes` catch
     * the families a package may extend without editing this file (the
     * email engine mints 'imessage-reservation' from a source's llmTag, and
     * a new bundled app's tags should land somewhere sane on their own).
     */
    SURFACES: [
        {
            // FIXED: chat runs on the DEFAULT MODEL, which is chosen by the
            // Default radio in the model list — so this surface has no row
            // in the assignment table and no assignment is ever stored
            // under modelRoutes.assistant (`resolve` ignores a stale one).
            // It is listed here because it owns source tags and is the
            // fallback every unmapped tag lands on. Noticing rides it on
            // purpose: judging what is worth a friend's follow-up deserves
            // the model the user trusts most.
            id: 'assistant',
            label: 'AI Assistant',
            desc: 'Chat and journal noticing. Runs on the default model.',
            fixed: true,
            sources: ['agent', 'noticing'],
            prefixes: []
        },
        {
            id: 'email',
            label: 'Email and texts',
            desc: 'Insights and reply drafts.',
            sources: [],
            prefixes: ['email', 'imessage']
        },
        {
            id: 'news',
            label: 'News',
            desc: 'Summaries, the digest, ranking.',
            sources: [],
            prefixes: ['news-', 'discover-']
        },
        {
            id: 'documents',
            label: 'Documents',
            desc: 'Tidying text, and reading pages.',
            sources: [],
            prefixes: ['doc-']
        },
        {
            id: 'portfolio',
            label: 'Portfolio',
            desc: 'Ticker profiles and the daily brief.',
            sources: [],
            prefixes: ['portfolio-']
        },
        {
            id: 'routines',
            label: 'Routines and tasks',
            desc: 'Scheduled work, and task mode.',
            sources: ['prompt-feed', 'task'],
            prefixes: ['task-']
        },
        {
            // The work a chat turn leaves behind plus the app's small
            // classifiers — the clearest candidates for a cheap fast model,
            // since none of them is read as prose by the user.
            id: 'quick',
            label: 'Small jobs',
            desc: 'Memory, filing, suggested prompts.',
            sources: ['ctx-summary', 'goal-update', 'goal-breakdown',
                'memory-extract', 'memory-consolidate', 'memory-compact',
                'voice-study', 'actions-filing', 'actions-capture',
                'actions-review', 'prompt-suggestions'],
            prefixes: ['memory-', 'actions-']
        }
    ],

    /** Anything unmapped is the assistant's: chat is the app's front door. */
    FALLBACK_SURFACE: 'assistant',

    surface(id) {
        return this.SURFACES.find(s => s.id === id) || null;
    },

    /**
     * Which surface owns an LLMLogger source tag. Exact match first (a tag
     * may deliberately sit outside its prefix family), then prefixes in
     * declaration order, then the assistant.
     */
    surfaceOf(source) {
        const tag = String(source || '');
        if (!tag) return this.FALLBACK_SURFACE;
        for (const s of this.SURFACES) {
            if (s.sources.includes(tag)) return s.id;
        }
        for (const s of this.SURFACES) {
            if (s.prefixes.some(p => tag.startsWith(p))) return s.id;
        }
        return this.FALLBACK_SURFACE;
    },

    /** Does this entry run on THIS Mac? A missing engine is the local one. */
    isLocal(entry) {
        return !!entry && (!entry.engine || entry.engine === 'llamacpp');
    },

    byId(list, id) {
        if (!id || !Array.isArray(list)) return null;
        return list.find(e => e && e.id === id) || null;
    },

    /**
     * The ONE local entry every local surface shares (R3). The brain wins
     * when it is local — it is what chat warmed and what the machine-global
     * context setting follows; otherwise the first local entry assigned to
     * a surface, in display order, so the answer is stable rather than
     * whichever call happened first.
     */
    localInPlay(assignments, list, defaultEntry) {
        if (this.isLocal(defaultEntry)) return defaultEntry;
        const a = assignments || {};
        for (const s of this.assignable()) {
            const e = this.byId(list, a[s.id]);
            if (this.isLocal(e)) return e;
        }
        return null;
    },

    /**
     * The entry that answers a surface.
     *
     * Returns { entry, assigned, coerced, overrides }:
     *   entry     — what will actually answer (the brain when nothing else).
     *   assigned  — a valid explicit assignment applied (R5: a dangling id
     *               is not an assignment).
     *   coerced   — R3 moved a second local assignment onto the one in play.
     *   overrides — the caller must ROUTE: the entry is not the brain.
     *               False for an unassigned surface, and false when the
     *               assignment happens to name the brain, which is what
     *               keeps R1 exact.
     */
    resolve(assignments, list, defaultEntry, surfaceId) {
        const def = defaultEntry || null;
        const spec = this.surface(surfaceId);
        // A fixed surface IS the brain, whatever a stale assignment says.
        if (spec && spec.fixed) return { entry: def, assigned: false, coerced: false, overrides: false };
        const wanted = this.byId(list, (assignments || {})[surfaceId]);
        let entry = wanted;
        let coerced = false;
        if (entry && this.isLocal(entry)) {
            const one = this.localInPlay(assignments, list, def);
            if (one && one.id !== entry.id) { entry = one; coerced = true; }
        }
        const eff = entry || def;
        return {
            entry: eff || null,
            assigned: !!entry,
            coerced,
            overrides: !!eff && (!def || eff.id !== def.id)
        };
    },

    /**
     * Surfaces whose explicit assignment R3 will not honour — what the
     * Settings picker refuses and explains. Never silent: a coerced
     * assignment the user cannot see is a lie about where work runs.
     */
    conflicts(assignments, list, defaultEntry) {
        const one = this.localInPlay(assignments, list, defaultEntry);
        const out = [];
        for (const s of this.assignable()) {
            const e = this.byId(list, (assignments || {})[s.id]);
            if (e && this.isLocal(e) && one && one.id !== e.id) out.push(s.id);
        }
        return out;
    },

    /**
     * The params patch that sends a call to `entry` — the same shape the
     * chat loop builds from an active entry, so main's llm-chat handlers
     * resolve the endpoint and the key by entry id. `numCtx` is lifted out
     * (LLMLogger merges it into params.options) so a patch never clobbers a
     * caller's own options block.
     */
    routingFor(entry) {
        if (!entry || !entry.model) return null;
        const engine = entry.engine || 'llamacpp';
        const out = { model: entry.model, engine };
        if (engine === 'server') {
            out.entryId = entry.id;
            if (entry.baseUrl) out.baseUrl = entry.baseUrl;
        } else if (engine === 'openai' || engine === 'anthropic' || engine === 'anjadhe') {
            out.entryId = entry.id;
        } else if (Number.isFinite(entry.numCtx) && entry.numCtx > 0) {
            out.numCtx = entry.numCtx;
        }
        return out;
    },

    /** Drop assignments naming entries that no longer exist (R5). */
    prune(assignments, list) {
        const out = {};
        for (const [k, v] of Object.entries(assignments || {})) {
            const spec = this.surface(k);
            if (spec && !spec.fixed && this.byId(list, v)) out[k] = v;
        }
        return out;
    },

    /**
     * The surfaces an ASSIGNMENT may name. The fixed one is excluded
     * because it is the brain: changeable, but through setDefaultEntry.
     */
    assignable() {
        return this.SURFACES.filter(s => !s.fixed);
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = ModelRouting;
