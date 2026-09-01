/**
 * notify.js — the one funnel for desktop notifications.
 * =====================================================
 * `Notify.show(title, body, opts)` raises the macOS notification (when
 * permission is granted) and mirrors the same title/body to the linked
 * Telegram chat as a plain message. The forward is fire-and-forget and the
 * GATE lives in main (js/main/telegram-bridge.js `notifyToLinked`: channel
 * enabled + the notifications toggle on + a linked chat) — the renderer
 * never caches the decision for sending, so a toggle flipped in Settings
 * takes effect on the very next notification.
 *
 * Reminder/alert call sites route through here: the schedule reminder scan
 * in AppManager, `TaskService._notifySystem` (unattended task/routine
 * moments), and Email's priority-insight notice. Deliberately NOT
 * forwarded: the Pomodoro end-of-round chime — it fires while the user is
 * at this Mac by definition, and would be noise on a phone.
 *
 * `telegramActive()` answers "would a forward actually go anywhere?" from a
 * cached status — it exists ONLY so the schedule scan keeps running when
 * macOS notification permission is denied but Telegram forwarding is on
 * (refreshed at init and by the Settings card on every Telegram change).
 */
const Notify = {
    _telegram: false,

    init() { this.refreshTelegram(); },

    /** Re-read (or accept) the bridge status; keeps `telegramActive()` honest. */
    async refreshTelegram(st) {
        if (!window.electronTelegram) { this._telegram = false; return; }
        try {
            const s = st || await window.electronTelegram.getStatus();
            this._telegram = !!(s && s.enabled && s.notify && s.chat);
        } catch { this._telegram = false; }
    },

    telegramActive() { return this._telegram; },

    /**
     * Raise a notification. opts: { silent } for the macOS banner,
     * { telegram: false } for local-only notices (Pomodoro-shaped),
     * { kind: 'reminder'|'task'|'routine'|'email' } — names what the
     * notice IS on the Telegram side, where it becomes the bold
     * "Anjadhe · Reminder" header that keeps a forwarded notification from
     * reading like an assistant reply (the macOS banner needs no such
     * header: the app icon already says who is talking).
     */
    show(title, body, opts = {}) {
        const b = String(body || '');
        try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                new Notification(title, { body: b, silent: !!opts.silent });
            }
        } catch { /* banner unavailable — Telegram may still carry it */ }
        if (opts.telegram !== false && window.electronTelegram) {
            window.electronTelegram.notify(String(title || ''), b, opts.kind || '').catch(() => {});
        }
    },
};
