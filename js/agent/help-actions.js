/**
 * HelpActions — the doors the assistant can put under an answer.
 *
 * A help answer that ends in "open Settings → AI Assistant → Web Search"
 * still leaves the user to find it. This registry is the other half: each
 * entry is ONE destination in the app, with the label the button carries
 * and the code that goes there. `get_help` and `get_setup_status`
 * (agent-tools.js) return action IDS with their results; agent-service
 * collects them onto the turn's metadata and agent-ui renders the row of
 * buttons under the answer.
 *
 * Two rules hold this together:
 *
 * 1. **Every action NAVIGATES, never mutates.** A button under an answer
 *    takes you to the page where you decide — it does not connect the
 *    account, spend the API key, or flip the setting. The assistant can
 *    already ask for a mutation through a normal tool call, which goes
 *    through the permission machinery; a button that quietly did the same
 *    thing would route around it. Adding an action that writes is a
 *    product decision, not a convenience.
 *
 * 2. **Labels live here, not in the model's answer.** Only ids are stored
 *    on the message metadata (and so only ids sync between Macs), so a
 *    label reworded next release re-renders correctly in old
 *    conversations, and a model that mangles a name cannot invent a
 *    button. An id that no longer exists renders nothing at all.
 *
 * Adding one: give it an id, a label in the app's own words (match the
 * Settings row it lands on), the `run` that gets there, and — when it
 * points at something gated or optional — an `available()` guard. Then
 * reference the id from the relevant HelpDocs doc's `actions` list.
 */
const HelpActions = {

    /**
     * The app's own navigation idiom: switch views, then run the deep-link
     * on the next tick (openApp renders synchronously, but each app's own
     * page render can queue work behind it).
     */
    _into(appName, then) {
        if (typeof AppManager === 'undefined') return;
        AppManager.openApp(appName);
        if (then) setTimeout(() => { try { then(); } catch { /* view not ready */ } }, 50);
    },

    _settings(fn) {
        this._into('settings', fn ? () => { if (typeof SettingsApp !== 'undefined') fn(SettingsApp); } : null);
    },

    ACTIONS: {
        // ── Setup ────────────────────────────────────────────────────
        'setup-checklist': {
            label: 'Open the setup checklist',
            run() { HelpActions._settings(S => S.openSetupAssistant()); }
        },
        'connect-google': {
            label: 'Connect Gmail & Calendar',
            run() { HelpActions._settings(S => S.openCategory('accounts')); }
        },
        'accounts': {
            label: 'Accounts',
            run() { HelpActions._settings(S => S.openCategory('accounts')); }
        },
        'ai-models': {
            label: 'Your models',
            run() { HelpActions._settings(S => S.openLLMSection('llm-sec-models')); }
        },
        'web-search': {
            label: 'Web search settings',
            run() { HelpActions._settings(S => S.openLLMSection('settings-search-section')); }
        },

        // ── The assistant ────────────────────────────────────────────
        'assistant-name': {
            label: 'Name the assistant',
            run() { HelpActions._settings(S => S.openLLMSection('llm-sec-name')); }
        },
        'terminal-access': {
            label: 'Terminal access',
            run() { HelpActions._settings(S => S.openLLMSection('settings-cli-section')); }
        },
        'tool-servers': {
            label: 'Tool servers (MCP)',
            run() { HelpActions._settings(S => S.openLLMSection('llm-sec-mcp')); }
        },
        'recipes': {
            label: 'Saved recipes',
            run() { HelpActions._settings(S => S.openLLMSection('llm-sec-recipes')); }
        },
        'assistant-permissions': {
            label: 'Assistant permissions',
            run() { HelpActions._settings(S => S.openLLMSection('llm-sec-permissions')); }
        },
        'memories': {
            label: 'What the assistant remembers',
            run() { HelpActions._settings(S => S.openMemoriesSettings()); }
        },
        'ai-logs': {
            label: 'AI call logs',
            run() { HelpActions._settings(S => S.openLlmLogs()); }
        },
        'ai-activity': {
            label: 'AI Activity',
            run() { HelpActions._into('aiactivity'); }
        },
        // C10 retired the separate Automations page; the id stays mapped to
        // Routines because it is PERSISTED on old assistant messages, and a
        // dangling id would render a button that goes nowhere.
        'automations': {
            label: 'Routines',
            run() { HelpActions._into('prompts'); }
        },
        'routines': {
            label: 'Routines',
            run() { HelpActions._into('prompts'); }
        },

        // ── Email ────────────────────────────────────────────────────
        'email-settings': {
            // Email's ONE settings surface is in-app (accounts + insights +
            // bundles), which is why this doesn't go to Settings at all —
            // same call AppManager.openAppSettings('email') makes.
            label: 'Email settings',
            run() {
                HelpActions._into('email', () => {
                    if (typeof EmailApp !== 'undefined') EmailApp.showPrioritySettings();
                });
            }
        },
        'inbox': {
            label: 'Open Inbox',
            run() { HelpActions._into('email'); }
        },
        'email-insights': {
            label: 'Open Email AI',
            run() { HelpActions._into('fyi'); }
        },

        // ── Everyday ─────────────────────────────────────────────────
        'tasks': {
            label: 'Open Tasks',
            run() { HelpActions._into('actions'); }
        },
        'goals': {
            label: 'Open Goals',
            run() { HelpActions._into('goals'); }
        },
        'news': {
            label: 'Open News',
            run() { HelpActions._into('news'); }
        },
        'portfolio': {
            label: 'Open Portfolio',
            run() { HelpActions._into('portfolio'); }
        },
        'calendar': {
            label: 'Open Calendar',
            run() { HelpActions._into('calendar'); }
        },
        'help-app': {
            label: 'Browse the full guide',
            run() { HelpActions._into('help'); }
        },

        // ── The app itself ───────────────────────────────────────────
        'appearance': {
            label: 'Appearance',
            run() { HelpActions._settings(S => S.openCategory('appearance')); }
        },
        'customize-home-apps': {
            label: 'Customize home apps',
            run() {
                if (typeof AppManager !== 'undefined' && AppManager.openAppVisibilityModal) {
                    AppManager.openAppVisibilityModal();
                } else {
                    HelpActions._settings(S => S.openCategory('appearance'));
                }
            }
        },
        'browser-settings': {
            label: 'Browser settings',
            run() { HelpActions._settings(S => S.openCategory('browser')); }
        },
        'storage-backup': {
            label: 'Storage & Backup',
            run() { HelpActions._settings(S => S.openStorageBackup()); }
        },
        'privacy-security': {
            label: 'Privacy & Security',
            run() { HelpActions._settings(S => S.openCategory('privacy')); }
        },
        'developer': {
            label: 'Developer settings',
            run() { HelpActions._settings(S => S.openCategory('build')); }
        },
        'maker': {
            label: 'Open Maker',
            // Gated (FEATURE_DEFAULTS.maker) — openApp would bounce home,
            // so the button doesn't render until the flag is on. The
            // 'developer' action above is the door to turning it on.
            available: () => typeof FEATURES === 'undefined'
                || !FEATURES.isGated('maker') || FEATURES.isEnabled('maker'),
            run() { HelpActions._into('maker'); }
        }
    },

    /** One action, or null when the id is unknown or currently unavailable. */
    get(id) {
        const a = this.ACTIONS[String(id || '')];
        if (!a) return null;
        if (typeof a.available === 'function') {
            try { if (!a.available()) return null; } catch { return null; }
        }
        return { id, label: a.label };
    },

    /** Resolve a list of ids to renderable actions — unknown ids dropped,
     *  order preserved, deduped, capped so an answer never grows a wall of
     *  buttons. */
    resolve(ids, max = 4) {
        const out = [];
        const seen = new Set();
        for (const id of Array.isArray(ids) ? ids : []) {
            if (seen.has(id)) continue;
            seen.add(id);
            const a = this.get(id);
            if (a) out.push(a);
            if (out.length >= max) break;
        }
        return out;
    },

    /** Go there. Silent no-op for an id that no longer exists — and for one
     *  that is currently unavailable, which `get` already keeps off screen;
     *  the gated apps among them would bounce to home rather than open. */
    open(id) {
        if (!this.get(id)) return;
        try { this.ACTIONS[id].run(); } catch (e) { console.warn('[help-actions] open failed:', id, e?.message); }
    },

    ids() {
        return Object.keys(this.ACTIONS);
    }
};
