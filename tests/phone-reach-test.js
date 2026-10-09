/**
 * PhoneReach (js/core/phone-reach.js), pure parts. Run: node tests/phone-reach-test.js
 *
 *   - vet (PR2): a message the assistant wrote may not carry a number or a
 *     link the facts lack, and stays short;
 *   - fallback: code's sentence is a proper sentence from the facts, never
 *     "Reminder: <title>";
 *   - the card ledger never sends the backlog: the first tick with reaching
 *     on records what is on Now and sends nothing, later ticks send only new
 *     or reopened cards, approval cards are left to the approval path, and
 *     the daily cap holds.
 */
const assert = require('assert');

const store = new Map();
global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
const sent = [];
global.window = { electronTelegram: {
    send: async (t) => { sent.push(t); return { ok: true, messageId: sent.length }; },
    getStatus: async () => ({ enabled: true, notify: true, chat: { id: 1 } }),
    onMessage: () => {},
} };
global.Notify = { forwardActive: () => true, refreshTelegram: () => {} };
const PhoneReach = require('../js/core/phone-reach.js');

(async () => {
    // --- vet ----------------------------------------------------------------
    const facts = { title: 'Dentist with Dr. Patel', when: 'Starting in 15 min, today at 3:00 PM' };
    assert.ok(PhoneReach.vet('Your dentist appointment with Dr. Patel starts in 15 minutes, at 3:00 PM.', facts), 'numbers from the facts pass');
    assert.ok(!PhoneReach.vet('Your dentist appointment starts at 4:00 PM.', facts), 'a time the facts lack fails');
    assert.ok(!PhoneReach.vet('Book it at https://example.com', facts), 'a link the facts lack fails');
    assert.ok(!PhoneReach.vet('x'.repeat(700), facts), 'too long fails');
    assert.ok(!PhoneReach.vet('', facts), 'empty fails');

    // --- fallback -------------------------------------------------------------
    const c = PhoneReach.fallback('commitment', { title: 'Dentist with Dr. Patel', when: 'Starting in 15 min, today at 3:00 PM', details: 'Bring the insurance card', project: '' });
    assert.strictEqual(c, 'Dentist with Dr. Patel: starting in 15 min, today at 3:00 PM. Bring the insurance card.');
    assert.ok(!/^Reminder/i.test(c), 'never "Reminder: <title>"');
    const k = PhoneReach.fallback('card', { title: 'Field trip form due Friday', details: 'It needs your signature and $12', changed: '' });
    assert.strictEqual(k, 'Field trip form due Friday. It needs your signature and $12.');

    // --- the card ledger ------------------------------------------------------
    PhoneReach.write = async (kind, f) => PhoneReach.fallback(kind, f); // no model in this test
    PhoneReach.CARD_DAY_MAX = 2;
    const card = (thing, title, extra = {}) => ({ raise: { thing, rev: 'r1', title, body: '', kind: 'headsup', ...extra } });
    let deck = [card('a', 'On Now before linking')];
    global.SimpleExperience = { cards: () => deck };

    await PhoneReach.tick();
    assert.strictEqual(sent.length, 0, 'the backlog is never sent');

    deck = [card('a', 'On Now before linking'), card('b', 'Car insurance renews on the 21st')];
    await PhoneReach.tick();
    assert.strictEqual(sent.length, 1, 'a new card is sent');
    assert.match(sent[0], /Car insurance renews/);

    await PhoneReach.tick();
    assert.strictEqual(sent.length, 1, 'a card is sent once');

    deck = [card('a', 'On Now before linking', { reopened: { at: 'later', why: 'New since you set this aside.' } }), card('b', 'Car insurance renews on the 21st'),
        card('c', 'Approve sending the reply', { kind: 'approval' })];
    await PhoneReach.tick();
    assert.strictEqual(sent.length, 2, 'a reopened card is sent again; an approval card is not sent as a card');
    assert.match(sent[1], /New since you set this aside/);

    deck = [...deck, card('d', 'Third today')];
    await PhoneReach.tick();
    assert.strictEqual(sent.length, 2, 'the daily cap holds');

    console.log('phone-reach: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
