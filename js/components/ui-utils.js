/**
 * UI Utilities
 * Reusable UI components and helpers
 */

const UIUtils = {
    /**
     * Show a toast notification
     * @param {string} message - Message to display
     * @param {string} type - Type: 'success', 'error', 'warning'
     * @param {number} duration - Duration in ms (default: 3000)
     * @param {Object} [opts] - Optional inline action, e.g. Undo:
     *   { actionLabel: 'Undo', onAction: () => {...} }. When present the toast
     *   shows a button; clicking it runs onAction and dismisses immediately.
     */
    showToast(message, type = 'success', duration = 3000, opts = {}) {
        const container = document.getElementById('toast-container');

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icons = {
            success: '✓',
            error: '✕',
            warning: '⚠'
        };

        const actionHtml = opts.actionLabel
            ? `<button type="button" class="toast-action">${opts.actionLabel}</button>`
            : '';
        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || '•'}</span>
            <span class="toast-message">${message}</span>
            ${actionHtml}
        `;

        container.appendChild(toast);

        let dismissed = false;
        const dismiss = () => {
            if (dismissed) return;
            dismissed = true;
            toast.style.animation = 'slideOutRight 0.3s ease-out';
            setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
        };

        if (opts.actionLabel) {
            const btn = toast.querySelector('.toast-action');
            btn.addEventListener('click', () => {
                try { opts.onAction && opts.onAction(); } finally { dismiss(); }
            });
        }

        setTimeout(dismiss, duration);
    },

    /**
     * Show confirmation dialog
     * @param {string} title - Dialog title
     * @param {string} message - Confirmation message
     * @param {string} icon - Icon emoji
     * @param {Object} [opts] - Optional button labels: { confirmText, cancelText }
     * @returns {Promise<boolean>}
     */
    confirm(title, message, icon = '❓', opts = {}) {
        return new Promise((resolve) => {
            const modal = Modal.create({
                title,
                className: 'confirm-dialog',
                content: `
                    <div class="confirm-icon">${icon}</div>
                    <div class="confirm-message">${message}</div>
                `,
                buttons: [
                    {
                        text: opts.cancelText || 'Cancel',
                        className: 'secondary-btn',
                        onClick: () => {
                            modal.close();
                            resolve(false);
                        }
                    },
                    {
                        text: opts.confirmText || 'Confirm',
                        className: 'primary-btn',
                        onClick: () => {
                            modal.close();
                            resolve(true);
                        }
                    }
                ]
            });
        });
    },

    /**
     * Today as YYYY-MM-DD in the USER'S timezone.
     *
     * Never use `new Date().toISOString().slice(0, 10)` for "today". That is
     * the UTC day, and west of UTC it turns over in the evening: at 9pm PDT
     * it already reads as tomorrow. Every date the app groups by is LOCAL
     * (TaskListUI._today and its cousins), so a UTC "today" handed to a model
     * came back as tasks dated a day ahead — a verification code that arrived
     * at 9:17pm was filed for tomorrow and appeared on neither the tasks page
     * nor home.
     *
     * @param {Date} [d]
     * @returns {string}
     */
    todayISO(d = new Date()) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    /**
     * Format date to readable string
     * @param {Date|string} date
     * @returns {string}
     */
    formatDate(date) {
        const d = new Date(date);
        const now = new Date();
        const diffMs = now - d;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
        if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
        if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;

        return d.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    },

    /**
     * Format date for display
     * @param {Date|string} date
     * @returns {string}
     */
    formatDateTime(date) {
        const d = new Date(date);
        return d.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    },

    /**
     * Debounce function
     * @param {Function} func
     * @param {number} wait
     * @returns {Function}
     */
    debounce(func, wait = 300) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },

    /**
     * Escape HTML to prevent XSS. Escapes quotes too, so the result is safe in
     * both text and attribute (title="…", href="…") contexts.
     * @param {string} text
     * @returns {string}
     */
    escapeHtml(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    /**
     * Replace bare ISO dates (2026-07-31) in model- or sender-authored text
     * with the reader's local short form ("Jul 31", plus the year when it
     * isn't this year). Display-level only — stored text keeps the ISO form.
     * Skips ISO timestamps (2026-07-31T10:00) and invalid month/day values.
     * @param {string} text
     * @returns {string}
     */
    humanizeIsoDates(text) {
        return String(text ?? '').replace(
            /\b(\d{4})-(\d{2})-(\d{2})\b(?![T:\d])/g,
            (match, y, m, d) => {
                const mi = +m, di = +d;
                if (mi < 1 || mi > 12 || di < 1 || di > 31) return match;
                const date = new Date(+y, mi - 1, di);
                const opts = { month: 'short', day: 'numeric' };
                if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
                return date.toLocaleDateString([], opts);
            }
        );
    },

    /**
     * SECURITY (M11): sanitize a URL destined for an href/src. Model- and
     * remote-API-supplied URLs (search results, Yahoo company websites) must not
     * carry a javascript:/data:/vbscript: scheme — those execute or navigate in
     * the renderer origin on click. Returns the URL only if it's http(s), mailto,
     * tel, an in-page anchor, or a relative path; otherwise '#'.
     * @param {string} url
     * @returns {string}
     */
    safeHref(url) {
        const s = String(url ?? '').trim();
        return /^(https?:|mailto:|tel:|#|\/|\.{1,2}\/)/i.test(s) ? s : '#';
    },

    /**
     * Is the display this window sits on laptop-sized? Built-in MacBook
     * panels report 1440–1728 logical px across (13" Air 1470, 14" Pro
     * 1512, 16" Pro 1728); external monitors start at 1920. Read at call
     * time, not cached: a laptop docked to a monitor should answer for the
     * screen the window is actually on.
     * @returns {boolean}
     */
    isCompactDisplay() {
        try { return (window.screen?.width || 0) < 1800; } catch { return false; }
    },

    /**
     * Default for the "reading pane" preference shared by Inbox, Email AI,
     * Notes and Journal: docked beside the list on a big monitor, OFF on a
     * laptop-sized display (2026-09-02, by request) where list + pane
     * squeezed both. Each app stores its own per-Mac key; this only decides
     * what an UNSET key means, so a user's explicit toggle always sticks.
     * @returns {boolean}
     */
    readerPaneDefault() {
        return !this.isCompactDisplay();
    },

    /**
     * Generate unique ID
     * @returns {string}
     */
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    },

    /**
     * Put a button into a busy state — disabled, spinner, optional replacement
     * label. Returns a function that restores the original label/state.
     *
     * Typical usage:
     *   const done = UIUtils.setButtonLoading(btn, 'Sending...');
     *   try { await doWork(); } finally { done(); }
     */
    setButtonLoading(btn, loadingLabel = null) {
        if (!btn) return () => {};
        const original = {
            html: btn.innerHTML,
            disabled: btn.disabled,
            ariaBusy: btn.getAttribute('aria-busy')
        };
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.classList.add('is-loading');
        const label = loadingLabel ? `<span class="btn-spinner-label">${this.escapeHtml(loadingLabel)}</span>` : '';
        btn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span>${label}`;
        return () => {
            btn.innerHTML = original.html;
            btn.disabled = original.disabled;
            if (original.ariaBusy === null) btn.removeAttribute('aria-busy');
            else btn.setAttribute('aria-busy', original.ariaBusy);
            btn.classList.remove('is-loading');
        };
    },

    /**
     * First-run welcome page for an app's blank state — a pitch, not a dead
     * end: serif title, one-line lede, the door(s) in, then hairline feature
     * rows (`.app-welcome*` in components.css). One builder so the welcome
     * pages cannot drift apart.
     *
     * Every string here is AUTHORED copy from the calling app — literals in
     * code, never user or model data — so nothing is escaped and rows may
     * carry entities/markup. Honest-copy rules apply to what goes in.
     *
     * @param {Object} o
     * @param {string} o.title    Serif headline
     * @param {string} o.lede     One- or two-sentence pitch under it
     * @param {string} [o.cta]    HTML for the door(s) in — usually a button
     * @param {string} [o.note]   Quiet line beside/under the CTA
     * @param {Array<[string,string]>} o.rows  [title, description] features
     * @returns {string} HTML
     */
    appWelcome({ title, lede, cta = '', note = '', rows = [] }) {
        return `
        <div class="app-welcome">
            <h2 class="app-welcome-title">${title}</h2>
            <p class="app-welcome-lede">${lede}</p>
            ${cta || note ? `<div class="app-welcome-cta">${cta}${note ? `<span class="app-welcome-note">${note}</span>` : ''}</div>` : ''}
            <div class="app-welcome-rows">
                ${rows.map(([t, d]) => `
                <div class="app-welcome-row">
                    <h3 class="app-welcome-row-title">${t}</h3>
                    <p class="app-welcome-row-desc">${d}</p>
                </div>`).join('')}
            </div>
        </div>`;
    }
};

// Add slideOutRight animation
const uiUtilsStyle = document.createElement('style');
uiUtilsStyle.textContent = `
    @keyframes slideOutRight {
        from {
            opacity: 1;
            transform: translateX(0);
        }
        to {
            opacity: 0;
            transform: translateX(100%);
        }
    }
`;
document.head.appendChild(uiUtilsStyle);
