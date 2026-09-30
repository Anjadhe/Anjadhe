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
 *       do not change; only the public MODEL ids moved (anjadhe-cloud →
 *       nenva-cloud-lite, anjadhe-cloud-qwen3.8 → nenva-cloud-pro), and
 *       `legacyId` is the one map main.js uses to retry an older Connect.
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

    /** Retired public id → its tier id (Connect keeps them as hidden aliases). */
    LEGACY: {
        'anjadhe-cloud': 'nenva-cloud-lite',
        'anjadhe-cloud-qwen3.8': 'nenva-cloud-pro'
    },

    /** The tier id for any cloud id, old or new. */
    publicId(id) {
        const s = typeof id === 'string' ? id.trim() : '';
        return this.LEGACY[s] || s;
    },

    /** The retired id an older Connect still knows, or null. */
    legacyId(id) {
        for (const [old, now] of Object.entries(this.LEGACY)) if (now === id) return old;
        return null;
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
     * description?}. A retired id comes back as its tier id; a known tier
     * carries nenva's own description, never the catalog's.
     */
    catalogRow(m) {
        const rawId = String((m && m.id) || '').trim();
        const id = this.publicId(rawId) || this.DEFAULT_CLOUD_MODEL;
        const label = this.cloudLabel(id, m && m.label);
        const desc = this.TIER_DESC[id]
            || (m && typeof m.description === 'string' && m.description.trim()) || '';
        return desc ? { id, label, description: desc } : { id, label };
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
    },

    /** A cloud entry moved to its tier id (N4: id untouched). Same object when unchanged. */
    migrateEntry(e) {
        if (!e || e.engine !== 'anjadhe') return e;
        const id = this.publicId(e.model);
        const tier = this.TIERS[id];
        const label = tier || this.cloudLabel(id, e.label);
        if (id === e.model && label === e.label) return e;
        return { ...e, model: id, label };
    },

    /**
     * The agent-settings blob moved onto tier ids. Idempotent. Returns
     * { changed, retired } where `retired` maps each label the migration
     * replaced (lowercased) to its tier name, so an old record that stored
     * that label can still be relabelled (N2).
     */
    migrateSettings(settings) {
        const out = { changed: false, retired: {} };
        if (!settings || typeof settings !== 'object') return out;
        if (Array.isArray(settings.modelList)) {
            settings.modelList = settings.modelList.map(e => {
                const m = this.migrateEntry(e);
                if (m !== e) {
                    out.changed = true;
                    const old = typeof e.label === 'string' ? e.label.trim().toLowerCase() : '';
                    if (old && old !== m.label) out.retired[old] = m.label;
                }
                return m;
            });
        }
        for (const k of ['cloudBrainModel', 'selectedModel']) {
            const v = settings[k];
            if (typeof v === 'string' && this.LEGACY[v]) { settings[k] = this.LEGACY[v]; out.changed = true; }
        }
        return out;
    },

    /**
     * The synced `phone-ai` choice ({fallback:{engine, model, label}} or a bare
     * {engine, model, label}) moved onto tier ids. Returns { value, changed }.
     */
    migratePhoneAI(value) {
        if (!value || typeof value !== 'object') return { value, changed: false };
        const fix = (c) => (c && typeof c === 'object' && c.engine === 'anjadhe') ? this.migrateEntry(c) : c;
        if (value.fallback && typeof value.fallback === 'object') {
            const f = fix(value.fallback);
            return f === value.fallback ? { value, changed: false } : { value: { ...value, fallback: f }, changed: true };
        }
        const v = fix(value);
        return { value: v, changed: v !== value };
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = ModelNames;
