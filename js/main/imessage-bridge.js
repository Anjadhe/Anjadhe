/**
 * imessage-bridge.js — iMessage as a NOTIFICATION channel (outbound only).
 * ======================================================================
 * Mirrors this Mac's desktop notifications to the user's own iMessage
 * handle by asking Messages.app to send them — so a reminder lands on
 * their iPhone and Watch as a text from themselves, Apple end-to-end,
 * with no bot, no token and no third-party server in the path. Apple
 * publishes no messaging API; scripting Messages.app is the only
 * supported way to SEND, and it is enough for this half.
 *
 * Deliberately NOT a chat channel: receiving would mean reading
 * ~/Library/Messages/chat.db under Full Disk Access (the whole message
 * history, an undocumented typedstream body format, and a self-chat
 * where both sides are `is_from_me`). That half is designed and parked
 * in docs/IMESSAGE_CHANNEL.md; the Telegram channel and the phone app
 * already carry chat-with-the-assistant.
 *
 * Gate (in main, so the renderer never caches the decision): the
 * notifications toggle on + a saved handle. Default OFF — a notification
 * leaving for Apple's servers is a disclosure, even an encrypted one.
 * Everything here is per-Mac (`settingsStore`): the Mac that runs
 * Messages.app is the Mac that sends.
 *
 * macOS gates the send with a per-app Automation consent (TCC) prompt for
 * Messages on first contact. The Settings card's "Send a test" exists so
 * that prompt appears while the user is at the Mac, not at 9:00 AM under
 * a reminder nobody sees.
 *
 * Message TEXT is never logged here — only the error class of a failed
 * send survives, in `lastError` for the Settings card.
 */
const { notificationText } = require('./notify-format');

const K_NOTIFY = 'imessageNotify';   // forward this Mac's notifications over iMessage
const K_HANDLE = 'imessageHandle';   // the user's own phone number or Apple ID email

// The text and the handle go in as ARGUMENTS, never spliced into the
// source — so no quoting bug can turn a notification body into script.
const SEND_SCRIPT = `on run argv
    set theHandle to item 1 of argv
    set theText to item 2 of argv
    tell application "Messages"
        set theAccount to 1st account whose service type = iMessage
        set theBuddy to participant theHandle of theAccount
        send theText to theBuddy
    end tell
end run`;

const HANDLE_RX = /^(\+?[0-9][0-9 ()-]{5,}|[^\s@]+@[^\s@]+\.[^\s@]+)$/;

/** Normalise a typed handle: trim; phone numbers lose spaces/punctuation. */
function normalizeHandle(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (s.includes('@')) return s.toLowerCase();
    return s.replace(/[\s()-]/g, '');
}

/** Turn osascript's stderr into one plain sentence the card can show. */
function explainError(raw) {
    const msg = String(raw || '');
    if (/-1743|not authorized to send Apple events/i.test(msg)) {
        return 'macOS blocked Anjadhe from controlling Messages. Open System Settings › Privacy & Security › Automation, find Anjadhe, and turn on Messages.';
    }
    if (/Can.t get account|service type/i.test(msg)) {
        return 'Messages on this Mac is not signed in to iMessage.';
    }
    if (/Can.t get participant|invalid participant|-1728/i.test(msg)) {
        return 'Messages could not find that handle. Use the phone number or email you iMessage with.';
    }
    if (/-600|not running|Application isn.t running/i.test(msg)) {
        return 'Messages could not be opened on this Mac.';
    }
    return msg.replace(/^\d+:\d+:\s*execution error:\s*/i, '').trim().slice(0, 200) || 'send failed';
}

/**
 * @param {object} deps
 * @param {object} deps.settingsStore  electron-store (per-Mac)
 * @param {(script: string, args: string[]) => Promise<{ok?:boolean,error?:string}>} deps.runScript
 *        Runs an AppleScript with argv; injected so the test never touches osascript.
 */
function createIMessageBridge({ settingsStore, runScript }) {
    let lastError = null;

    function status() {
        return {
            available: process.platform === 'darwin',
            notify: !!settingsStore.get(K_NOTIFY, false),
            handle: settingsStore.get(K_HANDLE, '') || '',
            lastError,
        };
    }

    function setNotify(on) {
        settingsStore.set(K_NOTIFY, !!on);
        if (!on) lastError = null;
    }

    /** Save the user's own handle. Empty clears it (and turns forwarding off). */
    function setHandle(raw) {
        const h = normalizeHandle(raw);
        if (!h) { settingsStore.delete(K_HANDLE); settingsStore.set(K_NOTIFY, false); lastError = null; return { ok: true }; }
        if (!HANDLE_RX.test(h)) return { error: 'Enter the phone number (with country code) or email you use for iMessage.' };
        settingsStore.set(K_HANDLE, h);
        lastError = null;
        return { ok: true };
    }

    /** Send one text to the saved handle through Messages.app. Best-effort. */
    async function send(text) {
        if (process.platform !== 'darwin') return { error: 'iMessage is only available on a Mac' };
        const handle = settingsStore.get(K_HANDLE, '') || '';
        if (!handle) return { error: 'no handle saved' };
        const s = String(text || '').trim();
        if (!s) return { skipped: true };
        try {
            const res = await runScript(SEND_SCRIPT, [handle, s]);
            if (res && res.error) { lastError = explainError(res.error); return { error: lastError }; }
            lastError = null;
            return { ok: true };
        } catch (e) {
            lastError = explainError(e.message);
            return { error: lastError };
        }
    }

    /**
     * Forward a desktop notification. Same text shape as Telegram
     * (js/main/notify-format.js) — iMessage has no bold, so the
     * "Anjadhe · Reminder" first line does the whole job of saying what
     * this is and why your own number is texting you.
     */
    async function notifyToLinked(title, body, kind) {
        if (!settingsStore.get(K_NOTIFY, false)) return { skipped: true };
        if (!settingsStore.get(K_HANDLE, '')) return { skipped: true };
        const n = notificationText(title, body, kind);
        if (!n) return { skipped: true };
        return send(n.text);
    }

    /** The Settings card's test: raises the TCC prompt while the user is here. */
    function sendTest() {
        return send(notificationText('Test from Anjadhe', "Notifications from this Mac will arrive here.", '').text);
    }

    return { status, setNotify, setHandle, send, notifyToLinked, sendTest, SEND_SCRIPT };
}

module.exports = { createIMessageBridge, normalizeHandle, explainError, SEND_SCRIPT };
