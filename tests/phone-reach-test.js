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

    // --- PR6: the message is the information, never a pointer to the app -----
    assert.ok(!PhoneReach.vet('There is a new card on the Now page about your car insurance.', {}), 'names the Now page');
    assert.ok(!PhoneReach.vet('Open the app to see the details.', {}), 'sends them to the app');
    assert.ok(!PhoneReach.vet('Check it on your Mac when you can.', {}), 'sends them to the Mac');
    assert.ok(PhoneReach.vet('Turn the porch light on now, the guests arrive soon.', {}), 'an ordinary "on now" passes');
    assert.ok(PhoneReach.vet('Your card statement is ready.', {}), 'the word card itself passes');

    // --- a card's buttons ride the message; a press runs the card's act ------
    sent.length = 0;
    const acted = [];
    const enq = [];
    global.TelegramChannel = { _enqueue: (m) => enq.push(m), _currentConv: () => null, _newConv: () => ({ messages: [] }) };
    global.AgentService = { _saveConversations: () => {} };
    const dentist = { key: 'meet:1', kind: 'headsup', title: 'Dentist at 3:00 PM', primary: 'Join call', url: 'https://meet.example/x',
        raise: { thing: 'event:1', rev: 'r1', title: 'Dentist at 3:00 PM', body: 'With Dr. Patel.', kind: 'headsup' } };
    const bill = { key: 'matter:m1:next', kind: 'decide', title: 'Water bill due Friday', primary: 'Draft the reply', matter: 'm1',
        raise: { thing: 'matter:m1', rev: 'r1', title: 'Water bill due Friday', body: '$42 to City Water.', kind: 'decide' } };
    deck = [dentist, bill];
    global.SimpleExperience = {
        cards: () => deck,
        cardActs: (c) => [{ act: 'primary', label: c.primary }, { act: c.kind === 'headsup' ? 'gotit' : 'later', label: c.kind === 'headsup' ? 'Got it' : 'Show later' }, ...(c.matter ? [{ act: 'ignore', label: 'Ignore' }] : [])],
        phonePlan: (c, act) => act !== 'primary' ? { how: 'do' } : c.url ? { how: 'url', url: c.url } : c.matter ? { how: 'ask', text: 'Draft my reply for "Water bill".' } : { how: 'none' },
        phoneCardAct: (key, act) => {
            acted.push([key, act]);
            if (!deck.some(c => c.key === key)) return { gone: true };
            if (act === 'primary') return { ask: true, text: 'Draft my reply for "Water bill".' };
            deck = deck.filter(c => c.key !== key);
            return { done: true };
        },
    };
    PhoneReach.CARD_DAY_MAX = 10;
    store.delete('phone-reach'); store.delete('phone-reach-msgs');
    deck = [];
    await PhoneReach.tick();                     // baseline: nothing on Now
    deck = [dentist, bill];
    await PhoneReach.tick();
    assert.strictEqual(sent.length, 2, 'both cards sent');
    const m1 = sent[0], m2 = sent[1];
    assert.strictEqual(typeof m1, 'object', 'a card with buttons is sent with them');
    assert.deepStrictEqual(m1.buttons[0], [{ text: 'Join call', url: 'https://meet.example/x' }], 'the primary is a link when the card has one');
    assert.strictEqual(m1.buttons[1][0].text, 'Got it');
    assert.deepStrictEqual(m2.buttons.flat().map(b => b.text), ['Draft the reply', 'Show later', 'Ignore'], 'the card\'s own labels, in order');

    // Show later, pressed on the phone: the card's act runs, the message keeps its words and loses its buttons.
    sent.length = 0;
    PhoneReach._onPress({ callback: m2.buttons[1][0].data, messageId: 2 });
    assert.deepStrictEqual(acted.pop(), ['matter:m1:next', 'later']);
    assert.strictEqual(sent[0].edit, 2);
    assert.match(sent[0].text, /\$42 to City Water\.\n\nShow later\.$/, 'says what was pressed under the message');
    PhoneReach._onPress({ callback: m2.buttons[1][0].data, messageId: 2 });
    assert.match(sent[1].text, /already taken care of/i, 'a second press is answered, not run');

    // A button that would open a chat on the Mac continues in the Telegram chat.
    deck = [dentist, { ...bill, raise: { ...bill.raise, rev: 'r2' } }];
    sent.length = 0;
    await PhoneReach.tick();                     // the bill changed: sent again
    const again = sent.find(x => typeof x === 'object' && /Water bill/.test(x.text));
    PhoneReach._onPress({ callback: again.buttons[0][0].data, messageId: 9 });
    assert.deepStrictEqual(enq.pop(), { text: 'Draft my reply for "Water bill".' }, 'the ask runs in the Telegram chat');

    // A card acted on at the Mac: the phone message loses its buttons.
    sent.length = 0;
    deck = [];
    await PhoneReach.tick();
    assert.ok(sent.some(x => x && x.edit === 1 && /Dentist/.test(x.text)), 'the dentist message is rewritten without buttons');

    console.log('phone-reach: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
