/**
 * AssistantIdentity — the user-chosen name for the AI assistant.
 *
 * Set in the setup wizard's last step (optional, skippable) or in
 * Settings › AI Assistant. Stored in the `assistant-identity` blob, which
 * syncs across Macs like any other StorageManager key (the name is
 * user-level, not machine-specific).
 *
 * Two consumers:
 *   - applyToDom() repaints every static "AI Assistant" surface (nav tile,
 *     titlebar button, panel header, breadcrumb default, composer
 *     placeholders). Called at startup and after every set().
 *   - AgentService.buildSystemMessages reads get() so the model knows its
 *     own name.
 *
 * No name set → every surface keeps its generic label ("AI Assistant" /
 * "Assistant" / "Ask Anjadhe anything…").
 */

const AssistantIdentity = {
    _key: 'assistant-identity',
    _maxLen: 30,

    _read() {
        try {
            const blob = StorageManager.get(this._key);
            return blob && typeof blob === 'object' ? blob : {};
        } catch (_) {
            return {};
        }
    },

    /** The custom name, or null when the user hasn't set one. */
    get() {
        const name = typeof this._read().name === 'string' ? this._read().name.trim() : '';
        return name ? name.slice(0, this._maxLen) : null;
    },

    /**
     * Save a new name (empty / whitespace clears it), then repaint. Any
     * explicit naming interaction also settles the nudge — someone who
     * set, changed, or cleared a name knows the feature exists.
     */
    set(name) {
        const clean = String(name || '').trim().slice(0, this._maxLen);
        const now = new Date().toISOString();
        StorageManager.set(this._key, {
            ...this._read(),
            name: clean,
            nudgeDismissedAt: this._read().nudgeDismissedAt || now,
            modifiedAt: now
        });
        this._removeNudges();
        this.applyToDom();
    },

    // ── "Give it a name" nudge ───────────────────────────────────────────
    // Existing installs predate the wizard's naming step, so Home and the
    // assistant's full view carry a quiet one-liner until the user names
    // the assistant or waves the nudge away. Skipping the wizard step
    // counts as a dismissal (recorded there), and the dismissal syncs.

    shouldNudge() {
        return !this.get() && !this._read().nudgeDismissedAt;
    },

    dismissNudge() {
        StorageManager.set(this._key, {
            ...this._read(),
            nudgeDismissedAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString()
        });
        this._removeNudges();
    },

    _removeNudges() {
        document.querySelectorAll('.assistant-name-nudge').forEach(el => el.remove());
    },

    /** Mount the nudge on Home + the assistant view. Call once at startup. */
    mountNudges() {
        if (!this.shouldNudge()) return;
        const dashHero = document.querySelector('.dash-agent-hero');
        if (dashHero && !document.getElementById('assistant-nudge-home')) {
            dashHero.insertAdjacentElement('afterend', this._buildNudge('assistant-nudge-home'));
        }
        const agentInputBar = document.querySelector('#agent-view .agent-input-bar');
        if (agentInputBar && !document.getElementById('assistant-nudge-agent')) {
            agentInputBar.insertAdjacentElement('beforebegin', this._buildNudge('assistant-nudge-agent'));
        }
    },

    _buildNudge(id) {
        const el = document.createElement('div');
        el.className = 'assistant-name-nudge';
        el.id = id;

        const dismissBtn = () => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'assistant-name-nudge-dismiss';
            b.title = 'Dismiss';
            b.setAttribute('aria-label', 'Dismiss');
            b.textContent = '×';
            b.addEventListener('click', () => this.dismissNudge());
            return b;
        };

        const paintEditor = () => {
            el.innerHTML = '';
            const input = document.createElement('input');
            input.type = 'text';
            input.maxLength = this._maxLen;
            input.placeholder = 'e.g. Juno, Atlas, Mia…';
            input.autocomplete = 'off';
            input.spellcheck = false;
            input.setAttribute('aria-label', 'Assistant name');
            const save = document.createElement('button');
            save.type = 'button';
            save.className = 'assistant-name-nudge-action';
            save.textContent = 'Save';
            const doSave = () => {
                if (!input.value.trim()) return;
                this.set(input.value);
                if (typeof UIUtils !== 'undefined') {
                    UIUtils.showToast(`Your assistant is now called ${this.get()}`, 'success');
                }
            };
            save.addEventListener('click', doSave);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); doSave(); }
                if (e.key === 'Escape') paintIdle();
            });
            el.append(input, save, dismissBtn());
            input.focus();
        };

        const paintIdle = () => {
            el.innerHTML = '';
            const text = document.createElement('span');
            text.className = 'assistant-name-nudge-text';
            text.textContent = 'Your assistant can have a name.';
            const action = document.createElement('button');
            action.type = 'button';
            action.className = 'assistant-name-nudge-action';
            action.textContent = 'Name it';
            action.addEventListener('click', paintEditor);
            el.append(text, action, dismissBtn());
        };

        paintIdle();
        return el;
    },

    /** Label for surfaces that say "AI Assistant" when unnamed. */
    displayName() {
        return this.get() || 'AI Assistant';
    },

    /**
     * Repaint every static label that shows the assistant's name. All
     * writes go through textContent / attribute setters, so a name never
     * lands in the DOM as markup.
     */
    applyToDom() {
        const name = this.get();
        const label = name || 'AI Assistant';

        // Left-nav / dashboard tiles (same markup on every page).
        document.querySelectorAll('.dash-app-tile[data-app="agent"] .dash-app-tile-label')
            .forEach(el => { el.textContent = label; });

        // Titlebar sparkle button.
        const toggle = document.getElementById('agent-toggle-btn');
        if (toggle) toggle.title = `${label} (Cmd+/)`;

        // Full app view: breadcrumb default (re-rendered with the same
        // label when the view opens) + header help/settings tooltips.
        const crumb = document.getElementById('agent-breadcrumb');
        if (crumb && !crumb.querySelector('a')) crumb.textContent = label;
        document.querySelectorAll('[data-help-for="agent"]').forEach(el => {
            el.title = `${label} help`;
            el.setAttribute('aria-label', `${label} help`);
        });
        document.querySelectorAll('[data-settings-for="agent"]').forEach(el => {
            el.title = `${label} settings`;
            el.setAttribute('aria-label', `${label} settings`);
        });

        // Docked panel header ("Assistant" when unnamed).
        const panelTitle = document.querySelector('#agent-panel .agent-header-title');
        if (panelTitle) panelTitle.textContent = name || 'Assistant';

        // Home composer: "Ask Anjadhe anything…" becomes "Ask <Name> anything…".
        const dashInput = document.getElementById('dash-agent-input');
        if (dashInput) dashInput.placeholder = `Ask ${name || 'Anjadhe'} anything…`;
        const dashHero = document.querySelector('.dash-agent-hero');
        if (dashHero) dashHero.setAttribute('aria-label', `Ask ${name || 'Anjadhe'}`);

        // Chat composers (panel + full view).
        const composerPh = name ? `Ask ${name} anything…` : 'Ask anything…';
        ['agent-input', 'agent-app-input'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.placeholder = composerPh;
        });
    }
};
