/**
 * imessage-bridge.js — explicit texts through this Mac's Messages app.
 * The assistant's send_text tool asks for consent in the renderer; main
 * validates the handle and sends fixed AppleScript with text as argv.
 * The saved own handle resolves "me". Notification forwarding was removed
 * 2026-10-07; reading texts for insights lives in imessage-reader.js.
 * Message text is never logged here.
 */
const K_HANDLE = 'imessageHandle';   // the user's own phone number or Apple ID email

// The text and the handle go in as ARGUMENTS, never spliced into the
// source — so no quoting bug can turn a message body into script.
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
        return 'macOS blocked nenva from controlling Messages. Open System Settings › Privacy & Security › Automation, find nenva, and turn on Messages.';
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
    // Retire the old forwarding opt-in, including on existing installs.
    settingsStore.delete('imessageNotify');

    function status() {
        return {
            available: process.platform === 'darwin',
            handle: settingsStore.get(K_HANDLE, '') || '',
        };
    }

    /** Save the user's own handle for explicit texts to "me". */
    function setHandle(raw) {
        const h = normalizeHandle(raw);
        if (!h) { settingsStore.delete(K_HANDLE); return { ok: true }; }
        if (!HANDLE_RX.test(h)) return { error: 'Enter the phone number (with country code) or email you use for iMessage.' };
        settingsStore.set(K_HANDLE, h);
        return { ok: true };
    }

    /**
     * Send one text to ANY handle — the assistant's send_text tool. The
     * decision to send was made in the renderer (the consent dialog shows
     * recipient and text); this only checks the handle's shape and runs
     * the script. Text is never logged.
     */
    async function sendTo(rawHandle, text) {
        if (process.platform !== 'darwin') return { error: 'iMessage is only available on a Mac' };
        const handle = normalizeHandle(rawHandle);
        if (!handle || !HANDLE_RX.test(handle)) return { error: 'That is not a phone number or an iMessage email.' };
        const s = String(text || '').trim();
        if (!s) return { error: 'empty message' };
        try {
            const res = await runScript(SEND_SCRIPT, [handle, s]);
            if (res && res.error) return { error: explainError(res.error) };
            return { ok: true, handle };
        } catch (e) {
            return { error: explainError(e.message) };
        }
    }

    return { status, setHandle, sendTo, SEND_SCRIPT };
}

module.exports = { createIMessageBridge, normalizeHandle, explainError, SEND_SCRIPT };
