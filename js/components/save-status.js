/**
 * SaveStatus — the one save indicator and the one flush-on-leave.
 *
 * Every auto-saving editor (task detail, project detail, Notes, Journal)
 * used to run its own timer and its own "Saved" label, and none of them
 * flushed when the user LEFT — a keystroke followed by Back within the
 * debounce window landed only if the orphaned DOM happened to survive
 * until the timer fired, which is how "autosave did not happen" was
 * reported (2026-09-10). Two laws now hold, both enforced here:
 *
 *  1. An open editor REGISTERS: `SaveStatus.register(id, { isDirty,
 *     flush, label, reopen? })`. `flush()` must save synchronously
 *     when it can (StorageManager.set is a sync IPC, so "saved" is known
 *     the moment it returns) and return `{ ok:true }` or `{ ok:false,
 *     reason }` when the form is not saveable (a task without a title).
 *  2. LEAVING flushes: AppManager's navigation hook, `pagehide`,
 *     `visibilitychange → hidden` and the unload guard all call
 *     `flushAll()`. Anything still dirty afterwards is announced
 *     (a toast naming the record and the reason, with a way back) and
 *     named in the native Leave/Stay confirm — never silently lost.
 *
 * The indicator is one markup shape (`.save-indicator` with an icon span
 * and a label span, styled in components.css) and five states:
 *   idle    — nothing to say (hidden). A fresh, untouched record.
 *   dirty   — "Unsaved" — edits exist that no write has carried yet.
 *   saving  — "Saving…" — only for genuinely async writes.
 *   saved   — "Saved" — the last write landed; quiets after a moment.
 *   error   — "Not saved · <reason>" — the form is invalid; the last
 *             valid state stands on disk.
 */
const SaveStatus = {
    STATES: ['idle', 'dirty', 'saving', 'saved', 'error'],
    LABELS: { idle: '', dirty: 'Unsaved', saving: 'Saving…', saved: 'Saved', error: 'Not saved' },

    _editors: new Map(),
    _quietTimers: new Map(),

    /** Register an open editor. Re-registering an id replaces its spec. */
    register(id, spec) {
        if (!id || !spec || typeof spec.flush !== 'function') return;
        this._editors.set(id, spec);
    },

    unregister(id) {
        this._editors.delete(id);
    },

    isRegistered(id) { return this._editors.has(id); },

    /**
     * Paint a state onto an indicator element (by element or id). `saved`
     * quiets to tertiary ink after 2.5 s so a long session doesn't sit on
     * a green check; the label stays so "is it saved?" always has an
     * answer on the page.
     */
    mark(elOrId, state, reason = '', { quiet = false } = {}) {
        const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
        if (!el || !this.STATES.includes(state)) return;
        el.dataset.state = state;
        // quiet: a record opened as already-saved shows the fact, not a
        // fresh green check.
        el.classList.toggle('is-quiet', quiet && state === 'saved');
        const label = el.querySelector('.save-indicator-label');
        let text = this.LABELS[state];
        if (state === 'error' && reason) text += ' · ' + reason;
        if (label) label.textContent = text;
        el.title = state === 'idle' ? '' : text;
        el.setAttribute('aria-label', text);
        const key = el.id || el;
        const prev = this._quietTimers.get(key);
        if (prev) clearTimeout(prev);
        if (state === 'saved') {
            this._quietTimers.set(key, setTimeout(() => {
                if (el.dataset.state === 'saved') el.classList.add('is-quiet');
                this._quietTimers.delete(key);
            }, 2500));
        }
    },

    /** The indicator's markup, for pages that render their head from JS. */
    html(id, state = 'idle', extraClass = '') {
        return `<span id="${id}" class="save-indicator ${extraClass}" data-state="${state}" aria-live="polite">` +
            `<span class="save-indicator-icon" aria-hidden="true"></span>` +
            `<span class="save-indicator-label">${this.LABELS[state] || ''}</span></span>`;
    },

    /**
     * Flush every registered editor that says it is dirty. Returns the
     * ones still dirty afterwards as [{ id, label, reason, reopen }].
     * `announce: true` also toasts each one (the "nice alert"): a warning
     * naming the record and why it could not be saved, with an inline
     * action to go back to it when the editor knows how.
     */
    flushAll({ announce = false } = {}) {
        const stuck = [];
        for (const [id, spec] of this._editors) {
            let dirty = false;
            try { dirty = !!spec.isDirty(); } catch (e) { console.warn('[save-status] isDirty failed', id, e); }
            if (!dirty) continue;
            let res;
            try { res = spec.flush() || { ok: true }; }
            catch (e) { console.warn('[save-status] flush failed', id, e); res = { ok: false, reason: 'could not save' }; }
            if (res.ok) continue;
            const label = (typeof spec.label === 'function' ? spec.label() : spec.label) || 'Unsaved changes';
            stuck.push({ id, label, reason: res.reason || '', actionLabel: res.actionLabel, onAction: res.onAction, reopen: spec.reopen || null });
        }
        if (announce) stuck.forEach(s => this.announce(s));
        return stuck;
    },

    /** Editors currently dirty, without flushing — for the unload guard. */
    dirtyLabels() {
        const out = [];
        for (const [, spec] of this._editors) {
            let dirty = false;
            try { dirty = !!spec.isDirty(); } catch { /* treat as clean */ }
            if (!dirty) continue;
            out.push((typeof spec.label === 'function' ? spec.label() : spec.label) || 'Unsaved changes');
        }
        return out;
    },

    /**
     * The "nice alert": a warning toast naming the record and why it was
     * not saved, with one inline action — the flush result's own
     * (Save / Go back) or, failing that, the editor's `reopen`.
     */
    announce({ label, reason, actionLabel, onAction, reopen }) {
        if (typeof UIUtils === 'undefined' || !UIUtils.showToast) return;
        const msg = `${label} not saved${reason ? ' — ' + reason : ''}`;
        const run = onAction || reopen;
        const opts = run ? { actionLabel: actionLabel || 'Go back', onAction: () => { try { run(); } catch (e) { console.warn('[save-status] action failed', e); } } } : {};
        UIUtils.showToast(msg, 'warning', 8000, opts);
    },

    /**
     * Wire the window-level flush points once. Navigation inside the app
     * goes through AppManager._notifyAppHidden, which calls flushAll too.
     */
    init() {
        if (this._wired) return;
        this._wired = true;
        window.addEventListener('pagehide', () => this.flushAll());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.flushAll();
        });
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = SaveStatus;
