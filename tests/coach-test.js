#!/usr/bin/env node
// Coach (js/core/coach.js, docs/COACH.md §5): the sheet a look starts from,
// pace, the checks on a raise and on a health concern (CO3, CO6), and the
// shared budget on Now (CO7).
const assert = require('assert');
const C = require('../js/core/commitments.js');
const Coach = require('../js/core/coach.js');
let store = null;
global.StorageManager = { get: k => (k === C.KEY ? store : null), set: (k, v) => { if (k === C.KEY) store = JSON.parse(JSON.stringify(v)); } };
const realToday = C.today;
C.today = (n) => n === undefined ? '2026-10-12' : realToday.call(C, n);
const NOW = new Date('2026-10-12T09:00:00');

// ── A 10K goal with a stage and reports ──
const g = C.create({ title: 'Run a 10K', outcome: 'Finish under an hour', by: '2027-03-01', domain: 'fitness', aim: { measure: 'distance', target: 6.2, unit: 'mi' } });
const s = C.create({ title: 'Easy runs', parent: g.id, when: { date: '2026-10-05' }, repeat: { rule: 'weekly', days: [1, 3, 5] }, until: '2026-10-18' });
C.report(s.id, { day: '2026-10-05', how: 'done', quote: 'ran 3 miles', measures: [{ name: 'distance', value: 3, unit: 'mi' }] });
C.report(s.id, { day: '2026-10-09', how: 'done', quote: 'ran 3.5 miles, knees fine', measures: [{ name: 'distance', value: 3.5, unit: 'mi' }] });
const bp = C.create({ title: 'Bring my blood pressure down', domain: 'health' });
C.report(bp.id, { day: '2026-10-11', quote: 'felt dizzy and had chest pain on the stairs' });
C.create({ title: 'Paint the fence' });
const all = () => C.all();

{
    assert.deepStrictEqual(Coach.goalsOf('fitness', all()).map(x => x.id), [g.id], 'only open top-level goals of that domain');
    const lines = Coach.sheetLines('fitness', all(), '2026-10-12').join('\n');
    assert.match(lines, /GOAL "Run a 10K" \(id [^)]+\): Finish under an hour, by 2027-03-01/);
    assert.match(lines, /Aim: distance 6\.2 mi or more by 2027-03-01/);
    assert.match(lines, /distance: 3\.5 mi on 2026-10-09, from 3 mi on 2026-10-05, 2\.7 mi to go/);
    assert.match(lines, /Step "Easy runs" \(id [^)]+\): repeats weekly on Mon, Wed, Fri from 2026-10-05 until 2026-10-18 \(in 6 days\); 2 of 4 done so far/);
    assert.match(lines, /2026-10-09 on "Easy runs": "ran 3\.5 miles, knees fine"/, 'their own words, newest first');
    assert.ok(!/Paint the fence/.test(lines), 'an uncoached commitment is not on the sheet');
}

// ── Pace (CO7) ──
{
    const f = Coach.figures('fitness', all(), '2026-10-12');
    const fp = Coach.fingerprint(f);
    assert.ok(Coach.due({}, fp, NOW), 'a first look');
    const looked = { lookedAt: NOW.getTime() - 3 * 86400000, lookedDay: '2026-10-09', fp };
    assert.ok(!Coach.due(looked, fp, NOW), 'nothing changed, under a week: no look');
    assert.ok(!Coach.due({ ...looked, lookedDay: '2026-10-12' }, 'other', NOW), 'never twice a day');
    C.report(s.id, { day: '2026-10-12', how: 'dropped', quote: 'skipped, raining' });
    const f2 = Coach.figures('fitness', all(), '2026-10-12');
    assert.ok(Coach.due(looked, Coach.fingerprint(f2), NOW), 'a new report is a reason to look');
    assert.deepStrictEqual(Coach.changes(f, f2, all()), ['They said 1 new thing about "Run a 10K".', '1 more day of "Run a 10K" marked done or skipped.']);
    assert.ok(Coach.due({ ...looked, lookAgain: '2026-10-12' }, fp, NOW), 'its own look-again day');
}

// ── A raise is checked (CO3) ──
{
    const goals = Coach.goalsOf('fitness', all());
    const known = new Set(Coach.nums(Coach.sheetLines('fitness', all(), '2026-10-12').join('\n')));
    const base = { domain: 'fitness', goals, known, st: { subjects: {} }, nowMs: NOW.getTime() };
    const ok = Coach.vetRaise({ goal: g.id, title: 'Next stage due', body: 'Easy runs end Oct 18. Want to plan the next two weeks with 3.5 mi as the long run?', offer: 'Plan it', ask: 'Plan my next stage' }, base);
    assert.ok(ok.card, JSON.stringify(ok)); assert.strictEqual(ok.card.subject, `goal:${g.id}`);
    // The sheet prints ids, which hold the clock and random digits, and the
    // coach counts those as read; so the unread number is one the sheet lacks.
    let unread = 42;
    while (known.has(String(unread))) unread++;
    assert.match(Coach.vetRaise({ goal: g.id, title: 'x', body: `You ran ${unread} miles.`, offer: 'a', ask: 'b' }, base).error, new RegExp(String(unread)), 'a number nobody read is refused');
    assert.match(Coach.vetRaise({ goal: bp.id, title: 'x', body: 'y', offer: 'a', ask: 'b' }, base).error, /fitness goals/, 'only this domain\'s goals');
    assert.match(Coach.vetRaise({ goal: g.id, title: 'x', body: 'y' }, { ...base, st: { subjects: { [`goal:${g.id}`]: { stop: true } } } }).error, /not to be coached/);
    assert.match(Coach.vetRaise({ goal: g.id, title: 'x', body: 'y' }, { ...base, raisedSoFar: [ok.card] }).error, /already raised/);
}

// ── A health concern: their words, code's line (CO6) ──
{
    const goals = Coach.goalsOf('health', all());
    const r = Coach.concernCard({ goal: bp.id, quote: 'chest pain on the stairs' }, { goals, all: all(), st: { subjects: {} } });
    assert.ok(r.card, JSON.stringify(r));
    assert.strictEqual(r.card.body, Coach.CONCERN_LINE, 'the words are code\'s');
    assert.match(r.card.title, /You mentioned “chest pain on the stairs”/);
    assert.match(Coach.concernCard({ goal: bp.id, quote: 'severe chest pain' }, { goals, all: all(), st: {} }).error, /copied exactly/, 'never a quote they did not say');
    assert.match(Coach.concernCard({ goal: bp.id, quote: 'chest pain on the stairs' }, { goals, all: all(), st: { subjects: { [`concern:${bp.id}`]: { quote: 'chest pain on the stairs' } } } }).error, /already/);
    assert.ok(Coach._system('health').includes('never medical advice'), 'the health know-how rides the look');
}

// ── Now's shared budget, and the nudge (CO7) ──
{
    const card = (d, sub, extra = {}) => ({ domain: d, subject: sub, goal: 'x', title: sub, body: 'b', ...extra });
    const state = { domains: {
        fitness: { cards: [card('fitness', 'goal:a'), card('fitness', 'goal:b')], subjects: { 'goal:b': { until: NOW.getTime() + 1000 } } },
        health: { cards: [card('health', 'concern:c', { concern: true })], subjects: {} },
        learning: { cards: [card('learning', 'goal:d')], subjects: { 'goal:d': { answered: true } } }
    } };
    assert.deepStrictEqual(Coach.shown(state, NOW.getTime(), 2).map(c => c.subject), ['concern:c', 'goal:a'], 'a concern first; put off and answered ones hidden');
    assert.deepStrictEqual(Coach.shown(state, NOW.getTime(), 1).map(c => c.subject), ['concern:c'], 'what the money coach left');
    assert.deepStrictEqual(Coach.shown(state, NOW.getTime(), 0), []);
    const noon = new Date('2026-10-12T12:00:00');
    assert.ok(Coach.nudgeChoice([card('fitness', 'goal:a')], {}, noon));
    assert.strictEqual(Coach.nudgeChoice([card('fitness', 'goal:a')], {}, noon, { moneyNudged: '2026-10-12' }), null, 'not on a day the money coach nudged');
    assert.strictEqual(Coach.nudgeChoice([card('fitness', 'goal:a')], { nudged: '2026-10-12' }, noon), null, 'one a day');
    assert.strictEqual(Coach.nudgeChoice([card('fitness', 'goal:a')], {}, new Date('2026-10-12T08:00:00')), null, 'daytime only');
}

// ── Adopting a goal, as an ordinary card (the health-data question went with the cloud-privacy classes) ──
{
    const ls = new Map();
    global.localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) };
    global.MemoryManager = { remember: () => {} };
    const nowMs = NOW.getTime();
    let cards = Coach.askCards(Coach.state(), all(), nowMs);
    assert.ok(!cards.some(c => /^privacy:/.test(c.subject)), 'no privacy question any more');

    // Adoption: candidates, the model's proposals checked, a card, an answer.
    const old = C.create({ title: 'Swim twice a week', when: { date: '2026-09-01' }, repeat: { rule: 'weekly', days: [2, 4] } });
    C.create({ title: 'Pay water bill', when: { date: '2026-10-20' } });
    const cands = Coach.adoptCandidates(all(), Coach.state(), nowMs);
    assert.ok(cands.some(c => c.id === old.id), 'a repeating habit with no domain is a candidate');
    assert.ok(!cands.some(c => c.title === 'Pay water bill'), 'a one-off with nothing behind it is not');
    assert.ok(!cands.some(c => c.domain), 'coached ones are not candidates');
    const props = Coach.vetAdopt({ coach: [{ id: old.id, domain: 'fitness' }, { id: 'nope', domain: 'fitness' }, { id: old.id, domain: 'fitness' }, { id: cands[0].id, domain: 'cooking' }] }, cands);
    assert.deepStrictEqual(props.map(p => [p.id, p.domain]), [[old.id, 'fitness']], 'only real candidates, coached areas, once');
    const st = Coach.state(); st.adopt = { proposals: props, fp: 'x', day: '' }; Coach.save(st);
    cards = Coach.askCards(Coach.state(), all(), nowMs);
    const card = cards.find(c => c.subject === `adopt:${old.id}`);
    assert.match(card.title, /Should I coach “Swim twice a week”\?/);
    Coach.respond(card.subject, 'accept');
    assert.strictEqual(C.get(old.id).domain, 'fitness', 'Coach it gives the goal its area, through the one door');
    assert.ok(!Coach.askCards(Coach.state(), all(), nowMs).some(c => c.subject === card.subject), 'asked once');
    delete global.MemoryManager;
}

// ── The end of a stage, looked back on: every word and figure code's ──
{
    const g2 = C.create({ title: 'Run a half marathon', domain: 'fitness', aim: { measure: 'long run', target: 13.1, unit: 'mi' } });
    const st = C.create({ title: 'Base building', parent: g2.id, when: { date: '2026-09-28' }, repeat: { rule: 'weekly', days: [1, 3, 6] }, until: '2026-10-10' });
    C.report(st.id, { day: '2026-09-28', how: 'done', quote: 'long run 4 miles', measures: [{ name: 'long run', value: 4, unit: 'mi' }] });
    C.report(st.id, { day: '2026-10-03', how: 'done', quote: 'did 5 miles', measures: [{ name: 'long run', value: 5, unit: 'mi' }] });
    C.report(st.id, { day: '2026-10-07', how: 'dropped', quote: 'sick' });
    C.report(st.id, { day: '2026-10-10', how: 'done', quote: '6 miles, felt strong', measures: [{ name: 'long run', value: 6, unit: 'mi' }] });
    let lb = Coach.lookbacks(C.all(), '2026-10-12', NOW.getTime()).find(x => x.goal === g2.id);
    assert.strictEqual(lb.title, '“Base building” is done');
    assert.match(lb.body, /^\d+ of \d+ done, 1 skipped, long run up from 4 mi to 6 mi\. The next stage is not planned yet\.$/);
    assert.strictEqual(lb.offer, 'Plan the next stage'); assert.match(lb.prompt, /Plan the next stage with me/);
    C.create({ title: 'Building to 8', parent: g2.id, when: { date: '2026-10-12' }, repeat: { rule: 'weekly', days: [1, 3, 6] }, until: '2026-10-25' });
    lb = Coach.lookbacks(C.all(), '2026-10-12', NOW.getTime()).find(x => x.goal === g2.id);
    assert.match(lb.body, /Next: “Building to 8”, from Monday, Oct 12\.$/); assert.strictEqual(lb.offer, 'Got it'); assert.strictEqual(lb.prompt, '');
    assert.ok(!Coach.lookbacks(C.all(), '2026-10-20', NOW.getTime()).some(x => x.goal === g2.id), 'a week later it is history, not a card');
    const ls = new Map(); global.localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) };
    assert.ok(Coach.askCards(Coach.state(), C.all(), NOW.getTime()).some(c => c.subject === lb.subject), 'it rides the ordinary cards');
    Coach.respond(lb.subject, 'accept');
    assert.ok(!Coach.askCards(Coach.state(), C.all(), NOW.getTime()).some(c => c.subject === lb.subject), 'once');
}

// ── Introductions (an area until there is a goal or an answer; one a day) ──
{
    global.CoachDomains = require('../js/core/coach-domains.js');
    const st = { asks: {}, introSince: 0 };
    let intros = Coach.intros(C.all(), st, NOW.getTime());
    assert.deepStrictEqual(intros.map(x => x.domain), ['money', 'learning', 'parenting'], 'an area with a goal (fitness, health) is not introduced; money is');
    assert.ok(intros.every(x => x.title && x.body && x.offer && x.prompt), 'code’s words, and the chat that plans one');
    const piano = C.create({ title: 'Play three songs from memory' });
    assert.ok(!Coach.intros(C.all(), { ...st, adopt: { proposals: [{ id: piano.id, domain: 'learning', title: piano.title }] } }, NOW.getTime()).some(x => x.domain === 'learning'),
        'an area whose goal the coach offered to adopt is introduced by that card');
    C.remove(piano.id, { by: 'you' });
    st.asks['intro:money'] = { until: NOW.getTime() + 1000 };
    st.asks['intro:learning'] = { answered: true };
    st.asks['intro:parenting'] = { stop: true };
    assert.deepStrictEqual(Coach.intros(C.all(), st, NOW.getTime()), [], 'Not now, an answer and Don’t ask each hide it');
    assert.deepStrictEqual(Coach.intros(C.all(), st, NOW.getTime() + 2000).map(x => x.domain), ['money'], 'Not now ends');
    assert.deepStrictEqual(Coach.intros(C.all(), { asks: {}, introSince: NOW.getTime() - 31 * 86400000 }, NOW.getTime()), [], 'an introduction, not a nag: gone after INTRO_DAYS');
    Coach.respond('intro:learning', 'stop');
    assert.ok(Coach.state().asks['intro:learning'].stop, 'Don’t ask is kept');

    // Paced (2026-10-11): nothing on the first day, then one a day, the assistant's pick.
    const DAY = 86400000, t0 = NOW.getTime();
    const fresh = { asks: {}, introSince: 0, introShown: {} };
    assert.strictEqual(Coach.introToday(C.all(), fresh, t0).card, null, 'nothing before the clock starts (that is the first day)');
    const d1 = { ...fresh, introSince: t0 };
    assert.strictEqual(Coach.introToday(C.all(), d1, t0 + 60000).card, null, 'nothing on the first day');
    const d2 = Coach.introToday(C.all(), d1, t0 + DAY);
    assert.ok(d2.needPick && !d2.card, 'the next day asks the assistant first, and shows nothing meanwhile');
    const day2 = Coach._iso(new Date(t0 + DAY));
    const picked = { ...d1, introPick: { day: day2, domain: 'parenting' } };
    assert.strictEqual(Coach.introToday(C.all(), picked, t0 + DAY).card.domain, 'parenting', 'the assistant picks the area');
    assert.strictEqual(Coach.introToday(C.all(), { ...d1, introPick: { day: day2, domain: null } }, t0 + DAY).card, null, 'and may pick none today');
    const shownToday = { ...picked, intro: { day: day2, domain: 'parenting' }, asks: { 'intro:parenting': { answered: true } } };
    assert.strictEqual(Coach.introToday(C.all(), shownToday, t0 + DAY).card, null, 'one a day: answering it brings no other that day');
    assert.ok(Coach.introToday(C.all(), shownToday, t0 + 2 * DAY).needPick, 'the next day is a new pick');
    const list = Coach.intros(C.all(), d1, t0 + DAY);
    assert.strictEqual(Coach.introFallback(list, { introShown: { money: t0 } }).domain, 'learning', 'without the assistant: the next area never shown');
    assert.strictEqual(Coach.introFallback(list, { introShown: { money: t0 + 5, learning: t0, parenting: t0 + 9 } }).domain, 'learning', 'else the one shown longest ago');
    assert.strictEqual(Coach.vetIntroPick({ area: 'Learning' }, list), 'learning');
    assert.strictEqual(Coach.vetIntroPick({ area: 'fitness' }, list), null, 'an area not left to introduce is none');
    assert.strictEqual(Coach.vetIntroPick({ area: null }, list), null);
    delete global.CoachDomains;
}

C.today = realToday;
console.log('coach: the sheet, pace, the checks on a raise and a concern, and the shared budget passed');
