#!/usr/bin/env node
/**
 * Simulated mail and texts (js/main/sim-sources.js, docs/THREADS_DEMO.md
 * "The simulation layer"): the clock, the two record shapes, the text
 * queue answering like chat.db, the scenario player, and SS1 (inert
 * without a test root AND the switch).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Sim = require('../js/main/sim-sources');

const now = new Date(2026, 9, 12, 12, 0, 0); // Mon Oct 12 2026, local

// parseAt: calendar days from now, a clock or 09:00
assert.strictEqual(Sim.parseAt('-2d 08:12', now).toString(), new Date(2026, 9, 10, 8, 12).toString());
assert.strictEqual(Sim.parseAt('+21d', now).toString(), new Date(2026, 10, 2, 9, 0).toString());
assert.strictEqual(Sim.parseAt('0d 16:48', now).toString(), new Date(2026, 9, 12, 16, 48).toString());
assert.strictEqual(Sim.parseAt('2026-01-05T10:00:00.000Z', now).toISOString(), '2026-01-05T10:00:00.000Z');
// weekday anchors: now is Monday Oct 12
assert.strictEqual(Sim.parseAt('thu+1 10:00', now).toString(), new Date(2026, 9, 15, 10, 0).toString(), 'the first Thursday at least a day out');
assert.strictEqual(Sim.parseAt('mon+1', now).toString(), new Date(2026, 9, 19, 9, 0).toString(), 'at least a day out: next Monday, not today');
assert.strictEqual(Sim.parseAt('mon+0', now).toString(), new Date(2026, 9, 12, 9, 0).toString(), 'zero days out: today when today is that day');
assert.strictEqual(Sim.parseAt('thu+1+4 09:00', now).toString(), new Date(2026, 9, 19, 9, 0).toString(), 'four days after that Thursday: the Monday');
assert.strictEqual(Sim.parseAt('tue+6-3', now).toString(), new Date(2026, 9, 17, 9, 0).toString(), 'three days before the Tuesday at least six days out (Oct 20): Saturday Oct 17');
assert.strictEqual(Sim.fill('{{dow:thu+1+6}} {{md:fri+1}}', now), 'Wednesday Oct 16');

// fill: dates inside words
assert.strictEqual(Sim.fill('renews on {{long:+21d}} ({{md:+21d}}, a {{dow:+21d}}, the {{nth:+21d}}; {{dmd:+21d}}; {{iso:+21d}}; {{clock:+21d 09:30}})', now),
    'renews on Monday, November 2 (Nov 2, a Monday, the 2nd; Mon, Nov 2; 2026-11-02; 9:30 AM)');
assert.strictEqual(Sim.fill('no placeholders {{x:+1d}}', now), 'no placeholders {{x:+1d}}');

// mailRecord: the Gmail record shape main hands the renderer
const m = Sim.mailRecord({ at: '-2d 08:12', from: 'Harbor Mutual <service@harbormutual.example>', subject: 'Your renewal offer is ready', important: true, category: 'CATEGORY_UPDATES',
    body: 'Renews on {{md:+21d}}.\n\nPremium: $724.00' }, now);
assert.strictEqual(m.account, Sim.SIM_ACCOUNT);
assert.strictEqual(m.to, `Emily Carter <${Sim.SIM_ACCOUNT}>`);
assert.deepStrictEqual(m.labels, ['INBOX', 'UNREAD', 'IMPORTANT', 'CATEGORY_UPDATES']);
assert.strictEqual(m.isRead, false);
assert.strictEqual(m.bodyText, 'Renews on Nov 2.\n\nPremium: $724.00');
assert.strictEqual(m.bodyHtml, '<p>Renews on Nov 2.</p><p>Premium: $724.00</p>');
assert.strictEqual(m.internalDate, String(new Date(2026, 9, 10, 8, 12).getTime()));
assert.ok(/^sim-your-renewal-offer-is-ready-\d+$/.test(m.messageId));
assert.strictEqual(m.snippet, 'Renews on Nov 2. Premium: $724.00');
const sent = Sim.mailRecord({ at: '0d', sent: true, to: 'quotes@lakesideins.example', subject: 'Quote', body: 'x' }, now);
assert.deepStrictEqual(sent.labels, ['SENT']);
assert.strictEqual(sent.from, `Emily Carter <${Sim.SIM_ACCOUNT}>`);
assert.strictEqual(sent.isRead, true);

// textRow + Queue: rows as imessage-reader returns them, read by cursor
const q = new Sim.Queue();
const r1 = q.push({ at: '-1d 16:48', handle: '+15125550142', chatName: 'Bright Smile Dental', text: 'Reply 1 for {{dmd:+6d}} 9:00 AM' }, now);
const r2 = q.push({ at: '0d 08:03', handle: '+15125550167', chatName: 'Mr. Alvarez', text: 'Minuet?' }, now);
assert.strictEqual(r1.rowid, 1); assert.strictEqual(r2.rowid, 2);
assert.strictEqual(r1.text, 'Reply 1 for Sun, Oct 18 9:00 AM');
assert.strictEqual(r1.fromMe, false);
assert.strictEqual(r1.chatIdentifier, '+15125550142');
assert.strictEqual(r1.chatGuid, 'SMS;-;+15125550142');
assert.strictEqual(r1.isGroup, false);
assert.strictEqual(r1.at, new Date(2026, 9, 11, 16, 48).toISOString());
for (const k of ['rowid', 'guid', 'text', 'at', 'fromMe', 'handle', 'hasAttachment', 'service', 'chatId', 'chatGuid', 'chatIdentifier', 'chatName', 'isGroup']) assert.ok(k in r1, k);
assert.deepStrictEqual(q.readSince({ afterRowid: 0 }).rows.map(r => r.rowid), [1, 2]);
assert.strictEqual(q.readSince({ afterRowid: 0 }).maxRowid, 2);
assert.deepStrictEqual(q.readSince({ afterRowid: 1 }).rows.map(r => r.rowid), [2]);
assert.deepStrictEqual(q.readSince({ afterRowid: 2 }), { ok: true, rows: [], maxRowid: 2, more: false });

// createSimSources: SS1, the reader wrapper, arrive, play
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-scen-'));
fs.writeFileSync(path.join(dir, 'tiny.json'), JSON.stringify({ steps: [
    { id: 'e1', kind: 'email', at: '-2d', from: 'A <a@x.example>', subject: 'past', body: 'p' },
    { id: 'c1', kind: 'calendar', at: '+1d', summary: 'not a message' },
    { id: 't1', kind: 'text', at: '0d 08:00', handle: '+15125550167', text: 'today' },
    { id: 't2', kind: 'text', at: '0d 09:00', handle: '+15125550167', text: 'a reply to the person', after: 'M3' },
    { id: 'e2', kind: 'email', at: '+2d', from: 'B <b@x.example>', subject: 'future', body: 'f' }
] }));
const realReader = { readSince: () => ({ ok: true, rows: [{ rowid: 99 }], maxRowid: 99, more: false }), probe: () => ({ ok: false, reason: 'fda' }) };
const sentOut = [];
const off = Sim.createSimSources({ dataRoot: '/tmp/x', enabled: false, reader: realReader, send: (c, p) => sentOut.push([c, p]), scenariosDir: dir });
assert.strictEqual(off.active, false);
assert.deepStrictEqual(off.reader.readSince({}).rows, [{ rowid: 99 }], 'off: the real reader answers');
assert.strictEqual(off.reader.probe().ok, false);
assert.strictEqual(off.arrive({ kind: 'email', subject: 'x' }).ok, false);
assert.strictEqual(off.play('tiny').ok, false);
assert.strictEqual(sentOut.length, 0);
const noRoot = Sim.createSimSources({ dataRoot: null, enabled: true, reader: realReader, send: () => {}, scenariosDir: dir });
assert.strictEqual(noRoot.active, false, 'the switch alone never turns it on');

const on = Sim.createSimSources({ dataRoot: '/tmp/x', enabled: true, reader: realReader, send: (c, p) => sentOut.push([c, p]), scenariosDir: dir });
assert.strictEqual(on.active, true);
assert.strictEqual(on.reader.probe().ok, true);
assert.deepStrictEqual(on.reader.readSince({ afterRowid: 0 }).rows, [], 'on: the queue answers, empty at first');
const a = on.arrive({ kind: 'email', at: '0d 10:00', from: 'C <c@x.example>', subject: 'now', body: 'n' });
assert.strictEqual(a.ok, true);
assert.strictEqual(sentOut.length, 1);
assert.strictEqual(sentOut[0][0], 'sim-mail-arrived');
assert.strictEqual(sentOut[0][1][0].subject, 'now');
const t = on.arrive({ kind: 'text', handle: '+1', text: 'hi' });
assert.strictEqual(t.row.rowid, 1);
assert.deepStrictEqual(on.reader.readSince({ afterRowid: 0 }).rows.map(r => r.text), ['hi']);
assert.strictEqual(on.arrive({ kind: 'calendar' }).ok, false);

const past = on.play('tiny', { upTo: 0 });
assert.deepStrictEqual(past.steps, ['t1'], 'upTo plays the TEXTS dated today or earlier (the seed planted the emails), never a calendar step or a step that follows a tap');
assert.deepStrictEqual(on.play('tiny', { step: 't2' }).steps, ['t2'], 'a step that follows a tap plays by name');
const one = on.play('tiny', { step: 'e2', at: '0d 10:05' });
assert.deepStrictEqual(one.steps, ['e2']);
const played = sentOut[sentOut.length - 1][1][0];
assert.strictEqual(played.subject, 'future');
assert.ok(Math.abs(Number(played.internalDate) - new Date().setHours(10, 5, 0, 0)) < 1000, 'at re-dates a played step');
assert.deepStrictEqual(on.play('tiny', { steps: ['e1', 'e2'] }).steps, ['e1', 'e2']);
assert.deepStrictEqual(on.play('tiny', {}).steps, [], 'nothing asked, nothing played');
assert.strictEqual(on.play('missing').ok, false);
assert.ok(on.status().log.length >= 3);
fs.rmSync(dir, { recursive: true, force: true });

// The shipped scenario parses, every step has a kind and an id, dates fill
const sc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sim-scenarios', 'threads-demo.json'), 'utf8'));
assert.ok(sc.steps.length > 30);
for (const s of sc.steps) {
    assert.ok(s.id && ['email', 'text', 'calendar', 'memory'].includes(s.kind), s.id);
    if (s.kind === 'email' || s.kind === 'text') assert.ok(!/\{\{/.test(Sim.fill(s.body || s.text, now)), `${s.id} has an unfilled placeholder`);
}
for (const [name, ids] of Object.entries(sc.senders)) for (const id of ids) assert.ok(sc.steps.some(s => s.id === id), `${name}: ${id} is not a step`);

console.log('sim-sources-test: ok');
