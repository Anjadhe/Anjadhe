/**
 * Feature flags.
 *
 * Code defaults for known features, overridden by boolean values in
 * remote-config.json's featureFlags. No Settings toggles or localStorage
 * overrides. To develop an unreleased feature, set its local config flag
 * to true and launch with ANJADHE_REMOTE_CONFIG=local npm start.
 * Restore false before publishing. Reload to rebuild gated registries/UI.
 *
 * Gating UI: add `data-feature="<key>"` to any element that should
 * disappear when the flag is off. AppManager calls applyToDocument()
 * at startup. Gating an app route: if the key is also an app slug in
 * AppManager, openApp() refuses to open it when the flag is off.
 */

const FEATURE_DEFAULTS = Object.freeze({
    // Graduated 2026-07-13: fs/shell tools, MCP client, and task mode
    // (docs/COWORK_AGENT.md C2–C4) shipped on for everyone after the
    // real-usage pass. Keys stay listed so any of them can be gated
    // again in an emergency by flipping to false.
    agentfs: true,
    mcp: true,
    taskmode: true,
    // Off by default (2026-07): phone pairing + relay sync (Settings →
    // Paired Devices, main.js desktop channel). Works end to end but is
    // unreleased — hosted-relay positioning/pricing is undecided, so
    // builds ship with it hidden. The flag gates the desktop side only:
    // main.js never connects to the relay unless the renderer calls
    // electronChannel.ensure(), which AppManager does only when this is on.
    mobilesync: false,
    // Off by default (2026-09-09): brokerage linking through Plaid on
    // nenva Connect (docs/PORTFOLIO.md "Brokerage linking"). Built and
    // tested end to end but unreleased — Plaid production access and the
    // paid-tier pricing it needs are pending, so builds ship with every
    // door hidden (PortfolioBrokerage.available() reads this flag).
    brokerage: false,
    // ON by default (2026-09-30, Ram: make the assistant proactive): the
    // assistant's own looks (docs/PROACTIVE.md) — meeting prep ~30 min
    // ahead, a morning notice joined from facts, and follow-up drafts for
    // sent mail nobody answered, on Home under Needs you. The flag is the
    // engine's on switch: AppManager.init starts it only when on.
    proactive: true,
    // ON by default (2026-10-05, Ram, the day it was built: "lets turn that
    // flag on by default too"): the person's own tasks and calendar events
    // become sources for their folders (docs/MATTERS.md §15 phase 3,
    // js/core/matter-sources.js). One triage call per batch decides which are
    // a real thing worth a folder; those go through Matters' own door. Adds
    // background model calls (never on a metered brain, S5); what it files
    // is read with `Matters.review()`. AppManager.init starts it.
    mattersources: true,
    // (`sharing` REMOVED 2026-10-09 with Portfolio sharing, the Contacts
    // card and the peer channel — docs/COACH.md §7.)
    // (`maker` REMOVED 2026-08-30 — the Maker artifact builder was deleted
    // entirely; a stale localStorage override for it is simply ignored.)
    // `library` GRADUATED 2026-08-08 (the C2/C3/C4 precedent): Documents (and
    // the writing voice, a Settings feature since 2026-09-02) ship
    // always-on; the embedding model stays an explicit download in Settings.
    // ON by default since 2026-10-04 (docs/COMMITMENTS.md phase 4): Tasks and
    // Projects as one AI-native store that IS the truth. The first start
    // backs up the old blobs, migrates once, and from then on the bridge
    // keeps the old `schedule` / `goals` / `links` blobs projected from the
    // commitments (every old reader, the phone included, sees the truth) and
    // takes every write to them back in. Turning it off leaves those blobs
    // current, so the old apps carry on; turning it on again imports first.
    commitments: true,
    // Unreleased (docs/TEACH.md): release-controlled, off by default.
    // Gates teaching tools, Settings/help, recording and saved playbooks.
    // Local experiment overrides cannot enable it; stored tasks are retained.
    teach: false,
    // Unreleased (2026-10-08, Ram: "put slack back behind the feature flag,
    // since its not ready yet"): the Slack connector (Settings › Connectors ›
    // Slack, its status tool and its help section). Monitoring also needs
    // `slackmonitor`. A Slack server already added under Tool Servers keeps
    // working as a plain MCP connection.
    slack: false,
    // ON by default (2026-10-09, docs/ROUTINES_UX.md "Routines are
    // instructions", step 1): a scheduled routine runs as a LOOK
    // (js/core/routine-look.js) that starts from its notebook and what it
    // already reported, and posts only a checked report (before → after),
    // with a Now card when the look says it earns one. Turned on once
    // tests/routine-look-eval.js passed clean on nenva cloud lite and a
    // local Qwen3.8 Flash. Flip to false in remote-config to roll back.
    routinelooks: true,
});

// One synchronous, memory/disk-only snapshot, before any gated registry loads.
const FEATURE_RELEASE_FLAGS = (() => {
    try {
        return Object.freeze(FeaturePolicy.resolve({ featureFlags: window.electronConfig.featureFlags() }));
    } catch { return Object.freeze(FeaturePolicy.resolve()); }
})();

const FEATURES = {
    isEnabled(name) {
        return FeaturePolicy.enabled(name, FEATURE_DEFAULTS, FEATURE_RELEASE_FLAGS);
    },

    isGated(name) {
        return Object.prototype.hasOwnProperty.call(FEATURE_DEFAULTS, name);
    },

    all() {
        const out = {};
        for (const key of Object.keys(FEATURE_DEFAULTS)) {
            out[key] = this.isEnabled(key);
        }
        return out;
    },

    applyToDocument(root = document) {
        root.querySelectorAll('[data-feature]').forEach((el) => {
            const feature = el.getAttribute('data-feature');
            if (!feature) return;
            if (!this.isEnabled(feature)) {
                el.style.display = 'none';
                el.setAttribute('aria-hidden', 'true');
            }
        });
    },


};

if (typeof window !== 'undefined') {
    window.FEATURES = FEATURES;
}
