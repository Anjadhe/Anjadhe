/**
 * ModelNames — how a model is NAMED to the person using nenva (2026-09-30).
 *
 * Product decision (Ram, 2026-09-30): the models nenva curates are named by
 * TIER, never by model. What runs underneath a tier changes as better
 * open-weight models ship; the name the person learned does not.
 *
 *   engine 'anjadhe'  (hosted on Connect) → "nenva cloud lite" / "nenva cloud pro"
 *                                           (an unknown id → "nenva cloud")
 *   engine 'llamacpp' (this Mac)          → "nenva local", whatever GGUF is installed
 *   everything else (the user's own server, OpenAI, Anthropic) → its real name
 *
 * Laws:
 *   N1  This file is the ONE place a model is named. AgentService.displayModelName
 *       (entries) and AgentService.displayForStoredModel (a bare stored name)
 *       are thin wrappers over it; no surface names a model any other way.
 *   N2  A stored name (message metadata, a feed post, a portfolio "written by",
 *       an AI Activity or LLM Logs row) is relabelled at RENDER time, so a
 *       record written before this date never shows the real id.
 *   N3  Ids are internal. The engine id 'anjadhe', storage keys and IPC names
 *       do not change; the public MODEL ids are the tier ids.
 *   N4  Entry ids never change in a migration: modelRoutes points at them.
 *
 * Pure, no DOM, no storage: pinned by tests/model-names-test.js.
 */
const ModelNames = {
    LOCAL_LABEL: 'nenva local',
    CLOUD_LABEL: 'nenva cloud',
    DEFAULT_CLOUD_MODEL: 'nenva-cloud-lite',

    /** Public cloud tier id → its name. */
    TIERS: {
        'nenva-cloud-lite': 'nenva cloud lite',
        'nenva-cloud-pro': 'nenva cloud pro'
    },

    /** What each tier is for, in the Add step (the catalog's own text may name a model). */
    TIER_DESC: {
        'nenva-cloud-lite': 'Fast, for everyday questions and background work.',
        'nenva-cloud-pro': 'A bigger model for harder questions. A little slower.'
    },

    /** A cloud id, trimmed. */
    publicId(id) {
        return typeof id === 'string' ? id.trim() : '';
    },

    isCloudId(id) {
        return typeof id === 'string' && /^(anjadhe|nenva)-cloud\b/i.test(id.trim());
    },

    isLocalEngine(engine) {
        return engine === 'llamacpp' || engine === 'ollama' || engine === 'local';
    },

    /**
     * Name for a hosted cloud model. A known tier is named by the tier,
     * whatever label an old catalog stamped on it. Any other id takes its
     * label only when that label already speaks as nenva (the operator named
     * it); otherwise it is simply "nenva cloud" — never a model's own name.
     */
    cloudLabel(model, label) {
        const tier = this.TIERS[this.publicId(model)];
        if (tier) return tier;
        const l = typeof label === 'string' ? label.trim() : '';
        if (/^nenva\b/i.test(l)) return l.replace(/^nenva cloud\b/i, 'nenva cloud').replace(/^nenva\b/i, 'nenva');
        return this.CLOUD_LABEL;
    },

    /**
     * One row of Connect's model catalog, named by tier: {id, label,
     * description?}. A known tier carries nenva's own description, never the
     * catalog's.
     */
    catalogRow(m) {
        const rawId = String((m && m.id) || '').trim();
        const id = this.publicId(rawId) || this.DEFAULT_CLOUD_MODEL;
        const label = this.cloudLabel(id, m && m.label);
        const desc = this.TIER_DESC[id]
            || (m && typeof m.description === 'string' && m.description.trim()) || '';
        const row = desc ? { id, label, description: desc } : { id, label };
        // Connect marks a model that reads images (its admin "Reads images",
        // 2026-09-30); AgentService.supportsVision reads it for nenva cloud.
        if (m && m.vision === true) row.vision = true;
        return row;
    },

    /** N1: the name for a model entry ({engine, model, label}). */
    displayName(entry) {
        if (!entry || typeof entry !== 'object') return '';
        if (entry.engine === 'anjadhe') return this.cloudLabel(entry.model, entry.label);
        if (this.isLocalEngine(entry.engine)) return this.LOCAL_LABEL;
        return String(entry.label || entry.model || '').trim();
    },

    /**
     * N2: the name for a bare stored model string. `engine` is the engine the
     * record logged, when it did. `known` maps a name (lowercased) to a tier
     * label for names only the caller can recognise (the current model list,
     * the local catalog, labels retired by the migration).
     */
    displayForStoredModel(name, engine, known) {
        const s = typeof name === 'string' ? name.trim() : '';
        if (!s) return '';
        if (engine === 'anjadhe' || this.isCloudId(s)) return this.cloudLabel(s, s);
        if (this.isLocalEngine(engine)) return this.LOCAL_LABEL;
        const low = s.toLowerCase();
        if (low === this.LOCAL_LABEL || low === this.CLOUD_LABEL || Object.values(this.TIERS).includes(low)) return low;
        if (/^nenva cloud\b/i.test(s)) return this.cloudLabel('', s);
        // The caller's own entries first: a server the user runs may serve
        // a file named *.gguf, and that is its real name to keep.
        if (known && typeof known === 'object') {
            const hit = known instanceof Map ? known.get(low) : known[low];
            if (hit) return hit;
        }
        if (/\.gguf$/i.test(s) || /[\\/]/.test(s)) return this.LOCAL_LABEL;
        // nenva's own local fine-tunes ('anjadhe-qwen3.5:4b').
        if (/^(anjadhe|nenva)-/i.test(s)) return this.LOCAL_LABEL;
        return s;
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = ModelNames;
