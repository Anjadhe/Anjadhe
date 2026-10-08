/**
 * notify.js — the one funnel for desktop notifications.
 * =====================================================
 * `Notify.show(title, body, opts)` raises the macOS notification (when
 * permission is granted) and mirrors the same title/body to the linked
 * Telegram chat. Forwarding is fire-and-forget and its gate lives in
 * main (notifyToLinked in js/main/telegram-bridge.js: channel enabled +
 * notifications toggle on + linked chat). A Settings change takes effect
 * on the very next notification.
 *
 * Reminder/alert call sites route through here: the schedule reminder scan
 * in AppManager, team jobs (js/agent/team-jobs.js: routine
 * moments), and Email's priority-insight notice. Deliberately NOT
 * forwarded: the Pomodoro end-of-round chime — it fires while the user is
 * at this Mac by definition, and would be noise on a phone.
 *
 * `forwardActive()` answers "would a forward actually go anywhere?" from a
 * cached status — it exists ONLY so the schedule scan keeps running when
 * macOS notification permission is denied but a forward lane is on
 * (refreshed at init and by the Settings cards on every change).
 */
const Notify = {
    _telegram: false,

    init() { this.refreshTelegram(); },

    /** Re-read (or accept) the bridge status; keeps `forwardActive()` honest. */
    async refreshTelegram(st) {
        if (!window.electronTelegram) { this._telegram = false; return; }
        try {
            const s = st || await window.electronTelegram.getStatus();
            this._telegram = !!(s && s.enabled && s.notify && s.chat);
        } catch { this._telegram = false; }
    },

    forwardActive() { return this._telegram; },

    /**
     * Raise a notification. opts: { silent } for the macOS banner,
     * { telegram: false } for local-only notices (Pomodoro-shaped),
     * { kind: 'reminder'|'task'|'routine'|'email'|'message', onClick? } —
     * onClick is what clicking the banner opens. `kind` names what the
     * notice IS on the forwarded side, where it becomes the "Reminder"
     * header (bold in Telegram) that keeps a forwarded notification from
     * reading like an assistant reply (the macOS banner needs no such
     * header: the app icon already says who is talking). No app name
     * anywhere in it. Give `body` a real summary: the
     * reader on a phone has no record to open, so "9:00 AM" alone is not
     * enough; say when, what it is about, and where it came from.
     */
    show(title, body, opts = {}) {
        const b = String(body || '');
        try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                const n = new Notification(title, { body: b, silent: !!opts.silent });
                // opts.onClick: what a click opens (2026-10-01). The window
                // comes forward first — it may be hidden in the menu bar.
                if (typeof opts.onClick === 'function') {
                    n.onclick = () => {
                        try { window.electronWindow?.showFocus?.(); } catch { /* best-effort */ }
                        try { opts.onClick(); } catch (e) { console.warn('[notify] click failed:', e?.message); }
                    };
                }
            }
        } catch { /* banner unavailable — Telegram may still carry it */ }
        if (opts.telegram !== false) {
            const t = String(title || '');
            if (window.electronTelegram) window.electronTelegram.notify(t, b, opts.kind || '').catch(() => {});
        }
    },
};
