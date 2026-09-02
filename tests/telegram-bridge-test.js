/**
 * Telegram bridge test (js/main/telegram-bridge.js), headless.
 *
 * Pins the security posture and the plumbing against a local stub of the
 * Telegram Bot API (ANJADHE_TELEGRAM_API override):
 *   - configure() validates the token via getMe and stores it encrypted;
 *   - the link handshake: only the exact one-time code links a chat, a
 *     stranger's message gets NO reply (no existence oracle), and once
 *     linked only that chat's messages are forwarded to the renderer;
 *   - non-text from the linked chat gets the "text only" notice;
 *   - sendToLinked chunks past Telegram's message cap;
 *   - notifyToLinked wears the bold "Anjadhe · <Kind>" header (entities,
 *     never parse_mode) so a forwarded notice never reads as a reply;
 *   - the poll loop advances its offset and forwards linked messages.
 *
 * Run: node tests/telegram-bridge-test.js
 */
const assert = require('assert');
const http = require('http');

const PORT = 8853;
process.env.ANJADHE_TELEGRAM_API = `http://127.0.0.1:${PORT}`;
const { createTelegramBridge } = require('../js/main/telegram-bridge');

const GOOD_TOKEN = '123456:goodtoken';

// ---- stub Telegram API ----------------------------------------------------
const sent = [];          // recorded sendMessage bodies
let updateQueue = [];     // handed out once by getUpdates, then empty
const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
        const reply = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
        };
        if (!m) return reply(404, { ok: false, description: 'not found' });
        const [, token, method] = m;
        if (token !== GOOD_TOKEN) return reply(401, { ok: false, description: 'Unauthorized' });
        const body = raw ? JSON.parse(raw) : {};
        if (method === 'getMe') {
            return reply(200, { ok: true, result: { username: 'anjadhe_test_bot', first_name: 'Anjadhe' } });
        }
        if (method === 'getUpdates') {
            const offset = body.offset || 0;
            const out = updateQueue.filter((u) => u.update_id >= offset);
            updateQueue = [];
            return reply(200, { ok: true, result: out });
        }
        if (method === 'sendMessage') { sent.push(body); return reply(200, { ok: true, result: {} }); }
        if (method === 'sendChatAction') { return reply(200, { ok: true, result: true }); }
        return reply(404, { ok: false, description: 'unknown method' });
    });
});

// ---- fakes ---------------------------------------------------------------
function makeStore() {
    const m = new Map();
    return {
        get: (k, d) => (m.has(k) ? m.get(k) : d),
        set: (k, v) => { m.set(k, v); },
        delete: (k) => { m.delete(k); },
    };
}
const FakeSecrets = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + s),
    decryptString: (b) => {
        const s = b.toString();
        if (!s.startsWith('enc:')) throw new Error('bad ciphertext');
        return s.slice(4);
    },
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const msgUpdate = (id, chatId, text, extra) => ({
    update_id: id,
    message: { chat: { id: chatId, type: 'private', first_name: 'Ram' }, text, message_id: id, date: 1, ...(extra || {}) },
});

(async () => {
    await new Promise((r) => server.listen(PORT, r));

    const store = makeStore();
    const broadcasts = [];
    const bridge = createTelegramBridge({
        settingsStore: store,
        Secrets: FakeSecrets,
        broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    // --- configure ---------------------------------------------------------
    const bad = await bridge.configure('999:wrong');
    assert.ok(bad.error && /rejected/i.test(bad.error), 'bad token rejected');
    const good = await bridge.configure(GOOD_TOKEN);
    assert.strictEqual(good.ok, true, 'good token accepted');
    assert.strictEqual(good.bot.username, 'anjadhe_test_bot');
    assert.ok(String(store.get('telegramToken')).length > 0, 'token stored');
    assert.ok(Buffer.from(store.get('telegramToken'), 'base64').toString().startsWith('enc:'),
        'token stored encrypted, not in cleartext');

    // --- link handshake ----------------------------------------------------
    const { code } = bridge.beginLink();
    assert.match(code, /^\d{6}$/, 'link code is six digits');

    // A stranger (or the user mistyping) gets NOTHING back — and no link.
    bridge._handleUpdate(GOOD_TOKEN, msgUpdate(1, 111, 'hello?'));
    bridge._handleUpdate(GOOD_TOKEN, msgUpdate(2, 111, '000000'));
    await wait(50);
    assert.strictEqual(sent.length, 0, 'no reply to unlinked chats (no existence oracle)');
    assert.strictEqual(store.get('telegramChat'), undefined, 'wrong code does not link');
    assert.strictEqual(broadcasts.length, 0, 'nothing forwarded before linking');

    // The right code links the sending chat and confirms in-chat.
    bridge._handleUpdate(GOOD_TOKEN, msgUpdate(3, 42, code));
    await wait(80);
    assert.strictEqual(store.get('telegramChat').id, 42, 'correct code links the chat');
    assert.strictEqual(sent.length, 1, 'link confirmation sent');
    assert.strictEqual(broadcasts.filter((b) => b.ch === 'telegram-linked').length, 1);

    // A used code is dead: another chat replaying it does not steal the link.
    bridge._handleUpdate(GOOD_TOKEN, msgUpdate(4, 666, code));
    await wait(50);
    assert.strictEqual(store.get('telegramChat').id, 42, 'code is one-time');

    // --- inbound filtering ---------------------------------------------------
    sent.length = 0; broadcasts.length = 0;
    bridge._handleUpdate(GOOD_TOKEN, msgUpdate(5, 42, 'what is on my schedule?'));
    const fwd = broadcasts.filter((b) => b.ch === 'telegram-message');
    assert.strictEqual(fwd.length, 1, 'linked chat message forwarded to renderer');
    assert.strictEqual(fwd[0].payload.text, 'what is on my schedule?');

    bridge._handleUpdate(GOOD_TOKEN, msgUpdate(6, 999, 'let me in'));
    assert.strictEqual(broadcasts.filter((b) => b.ch === 'telegram-message').length, 1,
        'stranger message not forwarded');

    // Non-text from the linked chat → polite text-only notice.
    bridge._handleUpdate(GOOD_TOKEN, {
        update_id: 7,
        message: { chat: { id: 42, type: 'private' }, photo: [{}], message_id: 7 },
    });
    await wait(80);
    assert.ok(sent.some((s) => /only read text/i.test(s.text)), 'non-text gets the notice');

    // Group chats are ignored entirely (private-only channel).
    broadcasts.length = 0;
    bridge._handleUpdate(GOOD_TOKEN, {
        update_id: 8,
        message: { chat: { id: 42, type: 'group' }, text: 'hi', message_id: 8 },
    });
    assert.strictEqual(broadcasts.length, 0, 'group messages ignored');

    // --- outbound chunking ---------------------------------------------------
    sent.length = 0;
    const long = 'x'.repeat(4500);
    const res = await bridge.sendToLinked(long);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(sent.length, 2, 'long reply split into two messages');
    assert.strictEqual(sent[0].text.length + sent[1].text.length, 4500, 'no characters lost');
    assert.ok(sent.every((s) => s.chat_id === 42), 'sent to the linked chat');

    // --- the poll loop -------------------------------------------------------
    broadcasts.length = 0;
    store.set('telegramEnabled', true);
    updateQueue = [msgUpdate(20, 42, 'via the poll loop'), msgUpdate(21, 555, 'stranger via poll')];
    bridge.start();
    await wait(300);
    bridge.stop();
    assert.strictEqual(store.get('telegramOffset'), 22, 'offset advanced past both updates');
    const polled = broadcasts.filter((b) => b.ch === 'telegram-message');
    assert.strictEqual(polled.length, 1, 'poll loop forwards only the linked chat');
    assert.strictEqual(polled[0].payload.text, 'via the poll loop');

    // --- notification forwarding ---------------------------------------------
    // Off by default: linking alone must not start forwarding notifications.
    sent.length = 0;
    let nres = await bridge.notifyToLinked('Standup', '9:00 AM');
    assert.ok(nres.skipped, 'notifications OFF by default — nothing forwarded');
    assert.strictEqual(bridge.status().notify, false, 'status reports the toggle off');

    bridge.setNotify(true);
    store.set('telegramEnabled', false);
    nres = await bridge.notifyToLinked('Standup', '9:00 AM');
    assert.ok(nres.skipped, 'channel master switch off → no forward');

    store.set('telegramEnabled', true);
    nres = await bridge.notifyToLinked('Standup', '9:00 AM', 'reminder');
    assert.strictEqual(nres.ok, true);
    assert.strictEqual(sent.length, 1, 'notification forwarded once');
    assert.strictEqual(sent[0].text, 'Anjadhe · Reminder\nStandup\n9:00 AM',
        'kind header, then title and body on their own lines');
    assert.deepStrictEqual(sent[0].entities, [
        { type: 'bold', offset: 0, length: 'Anjadhe · Reminder'.length },
        { type: 'bold', offset: 'Anjadhe · Reminder'.length + 1, length: 'Standup'.length },
    ], 'header and title are bold via entities (no parse_mode, nothing escaped)');
    assert.strictEqual(sent[0].parse_mode, undefined, 'never parse_mode — text needs no escaping');
    assert.strictEqual(sent[0].chat_id, 42, 'forwarded to the linked chat');
    assert.strictEqual(bridge.status().notify, true, 'status reports the toggle on');

    // An unknown or missing kind still reads as a notification, never as a reply.
    sent.length = 0;
    nres = await bridge.notifyToLinked('Standup', '9:00 AM');
    assert.strictEqual(sent[0].text, 'Anjadhe · Notification\nStandup\n9:00 AM', 'no kind → generic header');
    sent.length = 0;
    nres = await bridge.notifyToLinked('', 'body only', 'email');
    assert.strictEqual(sent[0].text, 'Anjadhe · Email\nbody only', 'no title → header then body');
    assert.strictEqual(sent[0].entities.length, 1, 'only the header is bold when there is no title');

    // A reply from the assistant carries no header and no entities — the
    // header is what distinguishes the two in one chat.
    sent.length = 0;
    await bridge.sendToLinked('plain reply');
    assert.strictEqual(sent[0].text, 'plain reply');
    assert.strictEqual(sent[0].entities, undefined, 'replies are unstyled');

    nres = await bridge.notifyToLinked('', '   ');
    assert.ok(nres.skipped, 'empty notification never sends');

    // --- disconnect ----------------------------------------------------------
    bridge.disconnect();
    assert.strictEqual(store.get('telegramToken'), undefined, 'disconnect removes the token');
    assert.strictEqual(store.get('telegramChat'), undefined, 'disconnect removes the link');
    assert.strictEqual(store.get('telegramNotify'), undefined, 'disconnect clears the notifications toggle');
    assert.strictEqual(bridge.status().configured, false);

    server.close();
    console.log('telegram-bridge: all assertions passed');
    process.exit(0);
})().catch((e) => {
    console.error('FAIL:', e && e.message);
    server.close();
    process.exit(1);
});
