/**
 * imessage-bridge.js — explicit texts through this Mac's Messages app.
 * The assistant's send_text tool asks for consent in the renderer; main
 * validates the handle and sends fixed AppleScript with text as argv.
 * The saved own handle resolves "me". Notification forwarding was removed
 * 2026-10-07; reading texts for insights lives in imessage-reader.js.
 * Message text is never logged here.
 *
 * Route, then check (2026-10-09). osascript exits 0 for a text Messages
 * will never deliver: an iMessage addressed to a number with no iMessage
 * sits in Messages as "Not Delivered" while the tool said "sent". So:
 *  - the SERVICE comes from chat.db — a handle last reached over SMS/RCS
 *    goes out on the SMS account (the iPhone's Text Message Forwarding);
 *  - after the script, the outgoing row is read back until it is
 *    delivered, failed or the wait runs out; a failed iMessage to a phone
 *    number is tried once as SMS; a failure is an ERROR, never a receipt;
 *  - when chat.db cannot be read (no Full Disk Access) the result says
 *    `status: 'unverified'`, never that the text arrived.
 */
const K_HANDLE = 'imessageHandle';   // the user's own phone number or Apple ID email

// The text and the handle go in as ARGUMENTS, never spliced into the
// source — so no quoting bug can turn a message body into script.
// Item 3 picks the account: "SMS" or the default iMessage.
const SEND_SCRIPT = `on run argv
    set theHandle to item 1 of argv
    set theText to item 2 of argv
    set theService to "iMessage"
    if (count of argv) > 2 then set theService to item 3 of argv
    tell application "Messages"
        if theService is "SMS" then
            set theAccount to 1st account whose service type = SMS
        else
            set theAccount to 1st account whose service type = iMessage
        end if
        set theBuddy to participant theHandle of theAccount
        send theText to theBuddy
    end tell
end run`;

// How long a send is watched in chat.db, and how often.
const VERIFY_MS = 12000;
const VERIFY_STEP_MS = 750;

/** Why Messages marked a text failed, in one sentence. */
function failureText(service, handle) {
    if (service === 'SMS') return 'Messages could not send it as a text message (SMS). Check that the iPhone is nearby with Text Message Forwarding on for this Mac.';
    if (!handle.includes('@')) return 'Messages could not deliver it over iMessage, and this number could not be reached as a text message either.';
    return 'Messages could not deliver it: that email is not reachable on iMessage.';
}

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
    if (/service type = SMS|account whose service type = SMS/i.test(msg)) {
        return 'This Mac cannot send SMS text messages. On the iPhone, turn on Settings › Apps › Messages › Text Message Forwarding for this Mac.';
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
 * @param {object} [deps.reader]  imessage-reader's serviceFor / lastRowid /
 *        outgoingAfter; absent or unreadable means "unverified", never "delivered".
 * @param {(ms:number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.verifyMs]
 */
function safe(fn) { try { return fn(); } catch { return null; } }

function createIMessageBridge({ settingsStore, runScript, reader = null, sleep = null, verifyMs = VERIFY_MS }) {
    const wait = sleep || (ms => new Promise(r => setTimeout(r, ms)));
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
        const isPhone = !handle.includes('@');
        // An email is iMessage only; a number goes where it last worked.
        let service = 'iMessage';
        if (isPhone && reader) {
            const r = safe(() => reader.serviceFor(handle));
            if (r && r.ok && /^(SMS|RCS)$/i.test(r.service || '')) service = 'SMS';
        }
        let first = await sendOnce(handle, s, service);
        if (first.error) return first;
        if (first.status === 'failed' && service === 'iMessage' && isPhone) {
            // The bug's case: no iMessage on this number. Try it as a text.
            const again = await sendOnce(handle, s, 'SMS');
            if (again.error) return { error: `${failureText('iMessage', handle)} ${again.error}`, handle };
            if (again.status !== 'failed') {
                return { ...again, note: 'iMessage could not reach this number, so it went as a text message (SMS). The failed iMessage copy stays in Messages marked Not Delivered.' };
            }
            first = again;
        }
        if (first.status === 'failed') {
            return { error: `${failureText(first.service, handle)} It is in Messages marked Not Delivered.`, handle, service: first.service, code: first.code };
        }
        return first;
    }

    /** Run the script on one service, then read back what Messages did. */
    async function sendOnce(handle, text, service) {
        const before = reader ? safe(() => reader.lastRowid()) : null;
        try {
            const res = await runScript(SEND_SCRIPT, [handle, text, service]);
            if (res && res.error) return { error: explainError(res.error) };
        } catch (e) {
            return { error: explainError(e.message) };
        }
        if (!before || !before.ok) return { ok: true, handle, service, status: 'unverified' };
        return { handle, service, ...(await verify(before.rowid, handle, service)) };
    }

    /**
     * Watch chat.db for our new message. Done when it is delivered, failed,
     * or (SMS, which rarely reports delivery) sent. Status only, never text.
     */
    async function verify(afterRowid, handle, service) {
        let last = null;
        for (let waited = 0; ; waited += VERIFY_STEP_MS) {
            const r = safe(() => reader.outgoingAfter(afterRowid, handle));
            if (!r || !r.ok) return { ok: true, status: 'unverified' };
            last = r.rows.length ? r.rows[r.rows.length - 1] : null;
            if (last && last.error) return { ok: false, status: 'failed', service: last.service || service, code: last.error };
            if (last && last.delivered) return { ok: true, status: 'delivered', service: last.service || service };
            if (last && last.sent && service === 'SMS') return { ok: true, status: 'sent', service: last.service || service };
            if (waited >= verifyMs) break;
            await wait(VERIFY_STEP_MS);
        }
        if (!last) return { ok: true, status: 'unconfirmed' };
        return { ok: true, status: last.sent ? 'sent' : 'unconfirmed', service: last.service || service };
    }

    return { status, setHandle, sendTo, SEND_SCRIPT };
}

module.exports = { createIMessageBridge, normalizeHandle, explainError, SEND_SCRIPT, VERIFY_STEP_MS };
