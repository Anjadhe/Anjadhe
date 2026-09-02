/**
 * notify.js — the one funnel for desktop notifications.
 * =====================================================
 * `Notify.show(title, body, opts)` raises the macOS notification (when
 * permission is granted) and mirrors the same title/body to the linked
 * Telegram chat and/or the user's own iMessage handle. The forwards are
 * fire-and-forget and each GATE lives in main (`notifyToLinked` in
 * js/main/telegram-bridge.js: channel enabled + the notifications toggle
 * on + a linked chat; in js/main/imessage-bridge.js: its toggle on + a
 * saved handle) — the renderer never caches the decision for sending, so
 * a toggle flipped in Settings takes effect on the very next notification.
 *
 * Reminder/alert call sites route through here: the schedule reminder scan
 * in AppManager, `TaskService._notifySystem` (unattended task/routine
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
    _imessage: false,

    init() { this.refreshTelegram(); this.refreshIMessage(); },

    /** Re-read (or accept) the bridge status; keeps `telegramActive()` honest. */
    async refreshTelegram(st) {
        if (!window.electronTelegram) { this._telegram = false; return; }
        try {
            const s = st || await window.electronTelegram.getStatus();
            this._telegram = !!(s && s.enabled && s.notify && s.chat);
        } catch { this._telegram = false; }
    },

    /** Same for the iMessage lane (toggle on + a saved handle). */
    async refreshIMessage(st) {
        if (!window.electronIMessage) { this._imessage = false; return; }
        try {
            const s = st || await window.electronIMessage.getStatus();
            this._imessage = !!(s && s.notify && s.handle);
        } catch { this._imessage = false; }
    },

    forwardActive() { return this._telegram || this._imessage; },

    /**
     * Raise a notification. opts: { silent } for the macOS banner,
     * { telegram: false } for local-only notices (Pomodoro-shaped),
     * { kind: 'reminder'|'task'|'routine'|'email' } — names what the
     * notice IS on the forwarded side, where it becomes the
     * "Anjadhe · Reminder" header (bold in Telegram) that keeps a forwarded
     * notification from reading like an assistant reply, or like a stray
     * text from your own number (the macOS banner needs no such header:
     * the app icon already says who is talking).
     */
    show(title, body, opts = {}) {
        const b = String(body || '');
        try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                new Notification(title, { body: b, silent: !!opts.silent });
            }
        } catch { /* banner unavailable — Telegram may still carry it */ }
        if (opts.telegram !== false) {
            const t = String(title || '');
            if (window.electronTelegram) window.electronTelegram.notify(t, b, opts.kind || '').catch(() => {});
            if (window.electronIMessage) window.electronIMessage.notify(t, b, opts.kind || '').catch(() => {});
        }
    },
};
