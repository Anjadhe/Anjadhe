/**
 * telegram-bridge.js — Telegram as a remote channel to the assistant.
 * ===================================================================
 * Lets the user chat with the nenva assistant on their Mac from the
 * Telegram app on their phone, through a bot THEY create (@BotFather) and
 * whose token they paste into Settings › Accounts › Telegram.
 *
 * Main-process side only: owns the token (encrypted via Secrets, never
 * synced), the long-poll loop, and the linked-chat allowlist. The AI run
 * itself happens in the renderer (AgentService.runHeadless — model calls
 * live there, like routines): incoming text is forwarded over
 * `telegram-message`, the renderer answers over the `telegram-send` IPC.
 *
 * Reachability model — the Mac DIALS OUT, like the relay and every other
 * nenva connection: `getUpdates` long-polling means no webhook, no
 * public server, no inbound port. Consequence of Telegram's API: only ONE
 * poller per bot token may run at a time (a second gets 409), so this is
 * configured on ONE Mac — the token lives in the machine-local
 * settingsStore, which never syncs, making that the default behavior.
 *
 * Security posture:
 *   - Anyone who finds the bot's handle can message it, so the bridge is
 *     LINKED to exactly one chat: Settings shows a one-time code, the user
 *     sends it to the bot from their own account, and that chat id becomes
 *     the allowlist. Everything else is ignored without a reply (no
 *     existence oracle). Re-linking replaces the chat.
 *   - Message text is never logged here (the model call is ledgered by
 *     LLMLogger in the renderer, which IS the disclosure surface).
 *   - Honest copy for the card: messages and replies travel through
 *     Telegram's servers — this channel is an explicit opt-in, like the
 *     cloud AI keys, never a default.
 */
'use strict';

// Dev/test override, same pattern as ANJADHE_RELAY_URL — the test suite
// points this at a local stub server.
const API_BASE = process.env.ANJADHE_TELEGRAM_API || 'https://api.telegram.org';
const POLL_TIMEOUT_S = 25;          // Telegram-side long-poll hold
const FETCH_TIMEOUT_MS = 40 * 1000; // must exceed the long-poll hold
const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const SEND_CHUNK = 3900;            // Telegram caps messages at 4096 chars
const { notificationText } = require('./notify-format');
const QRCode = require('qrcode');
const BOTFATHER_URL = 'https://t.me/BotFather';
// What the bot says on its own profile ("What can this bot do?"), written
// once to a fresh bot that has none, so the person's first look at it in
// Telegram says what it is. Telegram caps these at 512 / 120 characters.
const BOT_DESCRIPTION = 'Your nenva on your Mac. Press Start to link this chat, then write to it like you would in nenva: what is due this week, remind me to call the dentist tomorrow, mark the newsletters as read. It answers while your Mac is on.';
const BOT_SHORT_DESCRIPTION = 'Your nenva, from your phone. Answers while your Mac is on.';
const LINKED_TEXT = 'Linked. This chat now reaches nenva on your Mac. Write to it like you would in nenva, for example: \u201cwhat is due this week?\u201d, \u201cremind me to call the dentist tomorrow\u201d or \u201cmark the newsletters as read\u201d. It answers while your Mac is on.';

/**
 * A QR code as an inline SVG string, built synchronously from the module
 * matrix (QRCode.create) so callers stay sync. Dark modules use
 * currentColor; the page decides the colours.
 */
function qrSvg(text) {
    try {
        const qr = QRCode.create(String(text), { errorCorrectionLevel: 'M' });
        const n = qr.modules.size, d = qr.modules.data, q = 2;
        let path = '';
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
            if (d[y * n + x]) path += `M${x + q} ${y + q}h1v1h-1z`;
        }
        const w = n + q * 2;
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${w}" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
    } catch { return ''; }
}

/**
 * The link that opens the bot in Telegram with the code attached: pressing
 * Start sends "/start <code>", which links the chat with nothing to type.
 */
function startLink(username, code) {
    return username ? `https://t.me/${encodeURIComponent(username)}?start=${encodeURIComponent(code)}` : null;
}
const BACKOFF_BASE_MS = 5 * 1000;
const BACKOFF_MAX_MS = 60 * 1000;

// settingsStore keys (machine-local, never synced — deliberate, see header)
const K_TOKEN = 'telegramToken';       // encrypted, base64
const K_BOT = 'telegramBot';           // { username, name } — display only
const K_CHAT = 'telegramChat';         // { id, name } — the one linked chat
const K_ENABLED = 'telegramEnabled';
const K_NOTIFY = 'telegramNotify';     // forward this Mac's notifications to the linked chat
const K_OFFSET = 'telegramOffset';     // getUpdates cursor

function createTelegramBridge({ settingsStore, Secrets, broadcast }) {
    let running = false;
    let stopRequested = false;
    let pollAbort = null;
    let backoffMs = 0;
    let lastError = null;
    let linkCode = null;            // { code, expiresAt } while linking
    let loopPromise = null;

    // --- token (same fail-closed safeStorage pattern as the API keys) ----
    function getToken() {
        const stored = settingsStore.get(K_TOKEN, null);
        if (!stored) return null;
        if (!Secrets.isEncryptionAvailable()) return null;
        try { return Secrets.decryptString(Buffer.from(stored, 'base64')); }
        catch {
            console.warn('[telegram] stored bot token could not be decrypted — re-enter it in Settings › Accounts');
            return null;
        }
    }

    function api(token, method) {
        return `${API_BASE}/bot${token}/${method}`;
    }

    async function call(token, method, body, timeoutMs = 15000) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(api(token, method), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {}),
                signal: ctrl.signal,
            });
            const data = await res.json().catch(() => null);
            if (!data || data.ok !== true) {
                const desc = (data && data.description) || `HTTP ${res.status}`;
                const err = new Error(desc);
                err.status = res.status;
                throw err;
            }
            return data.result;
        } finally {
            clearTimeout(timer);
        }
    }

    // --- configuration ---------------------------------------------------
    /** Validate a pasted token against getMe and store it encrypted. */
    async function configure(token) {
        const t = String(token || '').trim();
        if (!t) return { error: 'Paste the bot token from @BotFather.' };
        if (!Secrets.isEncryptionAvailable()) {
            return { error: 'The OS keychain is unavailable — the token cannot be stored securely.' };
        }
        let me;
        try { me = await call(t, 'getMe'); }
        catch (e) {
            return { error: /401|unauthorized/i.test(String(e.message)) ? 'Telegram rejected that token.' : `Could not reach Telegram: ${e.message}` };
        }
        settingsStore.set(K_TOKEN, Secrets.encryptString(t).toString('base64'));
        settingsStore.set(K_BOT, { username: me.username || '', name: me.first_name || 'bot' });
        settingsStore.delete(K_OFFSET); // fresh cursor for a fresh bot
        lastError = null;
        describeBot(t).catch(() => {});
        return { ok: true, bot: settingsStore.get(K_BOT) };
    }

    /**
     * Give a bot with no description of its own nenva's, so the profile the
     * person sees before pressing Start says what it is. A bot someone
     * already described keeps its words. Best-effort.
     */
    async function describeBot(t) {
        const cur = await call(t, 'getMyDescription', {}).catch(() => null);
        if (cur && String(cur.description || '').trim()) return;
        await call(t, 'setMyDescription', { description: BOT_DESCRIPTION }).catch(() => {});
        await call(t, 'setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION }).catch(() => {});
    }

    /** Drop the token, the linked chat, and stop polling. */
    function disconnect() {
        stop();
        settingsStore.delete(K_TOKEN);
        settingsStore.delete(K_BOT);
        settingsStore.delete(K_CHAT);
        settingsStore.delete(K_OFFSET);
        settingsStore.delete(K_NOTIFY);
        settingsStore.set(K_ENABLED, false);
        linkCode = null;
        lastError = null;
    }

    function setEnabled(on) {
        settingsStore.set(K_ENABLED, !!on);
        if (on) start(); else stop();
    }

    function setNotify(on) {
        settingsStore.set(K_NOTIFY, !!on);
    }

    // --- linking ---------------------------------------------------------
    /** One-time code the user sends TO the bot to prove the chat is theirs. */
    function beginLink() {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        linkCode = { code, expiresAt: Date.now() + LINK_CODE_TTL_MS };
        // Linking needs the poll loop running to see the code arrive.
        if (settingsStore.get(K_ENABLED, false)) start();
        const bot = settingsStore.get(K_BOT, null);
        const link = startLink(bot && bot.username, code);
        return { code, bot, link, qr: link ? qrSvg(link) : '' };
    }
    function cancelLink() { linkCode = null; }
    function unlink() { settingsStore.delete(K_CHAT); }

    // --- status for the Settings card ------------------------------------
    function status() {
        const configured = !!settingsStore.get(K_TOKEN, null);
        return {
            configured,
            tokenReadable: !!getToken(),
            enabled: !!settingsStore.get(K_ENABLED, false),
            notify: !!settingsStore.get(K_NOTIFY, false),
            running,
            bot: settingsStore.get(K_BOT, null),
            chat: settingsStore.get(K_CHAT, null),
            linking: !!(linkCode && Date.now() < linkCode.expiresAt),
            lastError,
            // Step one of the guided setup (Settings › On your phone): where
            // a bot is made, as a link and a QR, while there is no bot yet.
            botFather: configured ? null : { url: BOTFATHER_URL, qr: botFatherQr() },
        };
    }

    let _bfQr = null;
    function botFatherQr() { return _bfQr || (_bfQr = qrSvg(BOTFATHER_URL)); }

    // --- outbound --------------------------------------------------------
    /**
     * Send the assistant's reply to the linked chat, chunked to the cap.
     * `opts.entities` (Telegram MessageEntity objects — offsets in UTF-16
     * units, which is what JS string indices already are) style the FIRST
     * chunk only; they are used instead of parse_mode so no text ever needs
     * escaping and a chunk boundary can never split a markup tag.
     */
    /*
     * The renderer's `send` takes a string, or (2026-10-08, js/core/
     * phone-reach.js) an object: { text, buttons } where buttons is
     * [{ text, data }] drawn as one row of inline buttons under the LAST
     * chunk (a press comes back as a callback, see handleUpdate), or
     * { edit: messageId, text } to rewrite a message nenva sent earlier and
     * drop its buttons (an approval answered on the Mac). The result carries
     * the sent message's id so the sender can edit it later.
     */
    async function sendToLinked(text, opts = {}) {
        if (text && typeof text === 'object') {
            const o = text;
            if (o.edit) return editLinked(o.edit, o.text);
            opts = { ...opts, buttons: o.buttons, entities: o.entities };
            text = o.text;
        }
        const token = getToken();
        const chat = settingsStore.get(K_CHAT, null);
        if (!token || !chat) return { error: 'not linked' };
        const s = String(text || '').trim() || '(empty reply)';
        const buttons = Array.isArray(opts.buttons)
            ? opts.buttons.filter(b => b && b.text && b.data && String(b.data).length <= 64).slice(0, 4)
            : [];
        let messageId = null;
        try {
            for (let i = 0; i < s.length; i += SEND_CHUNK) {
                const chunk = s.slice(i, i + SEND_CHUNK);
                const body = { chat_id: chat.id, text: chunk };
                if (i === 0 && Array.isArray(opts.entities)) {
                    const ents = opts.entities.filter(e => e && e.offset + e.length <= chunk.length);
                    if (ents.length) body.entities = ents;
                }
                if (buttons.length && i + SEND_CHUNK >= s.length) {
                    body.reply_markup = { inline_keyboard: [buttons.map(b => ({ text: String(b.text), callback_data: String(b.data) }))] };
                }
                const sentMsg = await call(token, 'sendMessage', body);
                if (sentMsg && sentMsg.message_id) messageId = sentMsg.message_id;
            }
            return { ok: true, messageId };
        } catch (e) {
            lastError = `send failed: ${e.message}`;
            return { error: e.message };
        }
    }

    /** Rewrite a message nenva sent (and drop its buttons). Best-effort. */
    async function editLinked(messageId, text) {
        const token = getToken();
        const chat = settingsStore.get(K_CHAT, null);
        if (!token || !chat || !messageId) return { error: 'not linked' };
        try {
            await call(token, 'editMessageText', {
                chat_id: chat.id, message_id: messageId,
                text: String(text || '').slice(0, SEND_CHUNK) || '(answered)',
                reply_markup: { inline_keyboard: [] },
            });
            return { ok: true, messageId };
        } catch (e) { return { error: e.message }; }
    }

    /**
     * Forward a desktop notification (a reminder, an alert) to the linked
     * chat. Gated by its OWN opt-in on top of the channel's master switch —
     * a notification leaving for Telegram's servers is a disclosure, so
     * nothing forwards until the user turns the Settings card's
     * notifications toggle on. Best-effort like the macOS notification it
     * mirrors; the app surface that raised it is still the record.
     *
     * Shape (built by js/main/notify-format.js): a
     * bold kind header line ("Reminder"), then the bold title, then the
     * body. The same chat carries the assistant's replies, which arrive as
     * plain prose — the header is what tells the two apart at a glance, so
     * a reminder never reads as the assistant answering something the user
     * did not ask.
     */
    async function notifyToLinked(title, body, kind) {
        if (!settingsStore.get(K_ENABLED, false)) return { skipped: true };
        if (!settingsStore.get(K_NOTIFY, false)) return { skipped: true };
        const n = notificationText(title, body, kind);
        if (!n) return { skipped: true };
        const entities = [{ type: 'bold', offset: 0, length: n.header.length }];
        if (n.title) entities.push({ type: 'bold', offset: n.header.length + 1, length: n.title.length });
        return sendToLinked(n.text, { entities });
    }

    /** "typing…" indicator while the model works. Best-effort. */
    function sendTyping() {
        const token = getToken();
        const chat = settingsStore.get(K_CHAT, null);
        if (!token || !chat) return;
        call(token, 'sendChatAction', { chat_id: chat.id, action: 'typing' }).catch(() => {});
    }

    // --- inbound ---------------------------------------------------------
    function handleUpdate(token, update) {
        // A press on one of nenva's inline buttons (an approval). Only the
        // linked chat's presses count; a stranger's is ignored with no
        // answer, like their messages. The press is acknowledged so the
        // button stops spinning, and handed to the renderer as a callback.
        const cq = update && update.callback_query;
        if (cq) {
            const linked = settingsStore.get(K_CHAT, null);
            const where = cq.message && cq.message.chat ? cq.message.chat.id : null;
            if (!linked || String(where) !== String(linked.id)) return;
            call(token, 'answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
            broadcast('telegram-message', {
                callback: String(cq.data || ''),
                messageId: cq.message ? cq.message.message_id : null,
            });
            return;
        }
        const msg = update && update.message;
        if (!msg || !msg.chat || msg.chat.type !== 'private') return;
        const chat = settingsStore.get(K_CHAT, null);
        const fromLinked = chat && String(msg.chat.id) === String(chat.id);

        // Link handshake: the right code from ANY private chat claims the
        // link (that's the point — the code came off the Mac's screen).
        // It arrives typed, or as "/start <code>" when the person opened
        // the bot through the start link and pressed Start.
        const code = linkCode && Date.now() < linkCode.expiresAt ? linkCode.code : null;
        const sentText = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (code && (sentText === code || sentText === `/start ${code}`)) {
            linkCode = null;
            const name = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ')
                || msg.chat.username || 'Telegram';
            settingsStore.set(K_CHAT, { id: msg.chat.id, name });
            call(token, 'sendMessage', {
                chat_id: msg.chat.id,
                text: LINKED_TEXT,
            }).catch(() => {});
            broadcast('telegram-linked', { name });
            return;
        }

        // Everything from an unlinked chat is dropped without a reply — a
        // stranger probing the bot handle learns nothing.
        if (!fromLinked) return;

        // Start pressed again in the linked chat: say what this chat is,
        // rather than handing the assistant a bare command.
        if (sentText === '/start') {
            call(token, 'sendMessage', { chat_id: msg.chat.id, text: LINKED_TEXT }).catch(() => {});
            return;
        }

        if (typeof msg.text !== 'string' || !msg.text.trim()) {
            call(token, 'sendMessage', {
                chat_id: msg.chat.id,
                text: 'I can only read text messages here for now.',
            }).catch(() => {});
            return;
        }

        sendTyping();
        // A swipe-reply to one of nenva's own messages ("move it to 4")
        // carries the message it answers, so the assistant knows what "it" is.
        const r = msg.reply_to_message;
        const replyTo = r && r.from && r.from.is_bot && typeof r.text === 'string' ? r.text.slice(0, 1500) : null;
        broadcast('telegram-message', {
            text: msg.text,
            date: msg.date || null,
            messageId: msg.message_id || null,
            replyTo,
        });
    }

    // --- the poll loop ---------------------------------------------------
    async function pollLoop() {
        while (!stopRequested) {
            const token = getToken();
            if (!token) { lastError = 'Bot token unavailable'; break; }
            try {
                pollAbort = new AbortController();
                const timer = setTimeout(() => pollAbort.abort(), FETCH_TIMEOUT_MS);
                let updates;
                try {
                    const res = await fetch(api(token, 'getUpdates'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            timeout: POLL_TIMEOUT_S,
                            offset: settingsStore.get(K_OFFSET, 0) || undefined,
                            allowed_updates: ['message', 'callback_query'],
                        }),
                        signal: pollAbort.signal,
                    });
                    const data = await res.json().catch(() => null);
                    if (!data || data.ok !== true) {
                        const desc = (data && data.description) || `HTTP ${res.status}`;
                        const err = new Error(desc);
                        err.status = res.status;
                        throw err;
                    }
                    updates = data.result || [];
                } finally {
                    clearTimeout(timer);
                    pollAbort = null;
                }

                lastError = null;
                backoffMs = 0;
                for (const u of updates) {
                    // Advance the cursor BEFORE handling: a handler error must
                    // not make Telegram redeliver the same update forever.
                    settingsStore.set(K_OFFSET, u.update_id + 1);
                    try { handleUpdate(token, u); }
                    catch (e) { console.warn('[telegram] update handling failed:', e.message); }
                }
            } catch (e) {
                if (stopRequested) break;
                if (e.name === 'AbortError') continue; // our own timeout — repoll
                if (e.status === 401 || e.status === 404) {
                    lastError = 'Telegram rejected the bot token — reconnect in Settings.';
                    console.warn('[telegram] fatal:', lastError);
                    break; // polling a dead token forever helps no one
                }
                if (e.status === 409) {
                    // Another getUpdates consumer holds this bot (another Mac,
                    // or a webhook). Keep trying slowly — the other side may quit.
                    lastError = 'Another connection is receiving this bot\'s messages (another Mac?). Retrying.';
                } else {
                    lastError = `Telegram unreachable: ${e.message}`;
                }
                backoffMs = Math.min(backoffMs ? backoffMs * 2 : BACKOFF_BASE_MS, BACKOFF_MAX_MS);
                await new Promise((r) => setTimeout(r, backoffMs));
            }
        }
        running = false;
    }

    function start() {
        if (running) return;
        if (!settingsStore.get(K_ENABLED, false)) return;
        if (!settingsStore.get(K_TOKEN, null)) return;
        running = true;
        stopRequested = false;
        backoffMs = 0;
        loopPromise = pollLoop();
        console.log('[telegram] bridge polling started');
    }

    function stop() {
        stopRequested = true;
        if (pollAbort) { try { pollAbort.abort(); } catch { /* mid-close */ } }
        running = false;
    }

    return {
        configure, disconnect, setEnabled, setNotify,
        beginLink, cancelLink, unlink,
        status, sendToLinked, notifyToLinked, sendTyping,
        start, stop,
        /** Test seam: run one update through the inbound filter. */
        _handleUpdate: handleUpdate,
    };
}

module.exports = { createTelegramBridge };
