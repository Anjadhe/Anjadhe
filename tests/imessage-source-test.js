/**
 * iMessage source test (js/apps/email/imessage-source.js), headless.
 *
 * Pins the pure core — fold() and buildRecord() — with no DOM, no
 * EmailApp and no Messages database:
 *   - lines from one chat buffer until the chat is quiet, hits the line
 *     cap, or has been open too long; a quiet gap INSIDE a backlog is a
 *     boundary too;
 *   - a buffer of only the user's own texts never becomes a record
 *     (the engine's _isIncoming law);
 *   - the record is email-shaped (messageId 'imsg:<guid>', from
 *     "Label <addr>", subject = first incoming line, INBOX label,
 *     source 'imessage'), carries the previous conversation's tail as
 *     flagged context, and caps its body from the OLD end.
 *
 * Run: node tests/imessage-source-test.js
 */
const assert = require('assert');
const S = require('../js/apps/email/imessage-source');

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 8, 10, 15, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const row = (rowid, atMs, text, o = {}) => ({
    rowid, guid: `g${rowid}`, text, at: iso(atMs), fromMe: !!o.fromMe,
    handle: o.handle ?? '+14255550100', hasAttachment: !!o.att, service: 'iMessage',
    chatId: o.chatId ?? 1, chatGuid: o.chatGuid ?? 'iMessage;-;+14255550100',
    chatIdentifier: o.chatIdentifier ?? '+14255550100', chatName: o.chatName ?? '', isGroup: !!o.isGroup,
});
const limits = { QUIET_MS: 10 * MIN, MAX_LINES: 5, MAX_SPAN_MS: 6 * 60 * MIN, CONTEXT_LINES: 2, BODY_CHARS: 3000, SUBJECT_CHARS: 40 };

// --- a chat that is still talking stays open --------------------------
let f = S.fold({}, [row(1, T0, 'Dentist Tue 3pm — reply C to confirm'), row(2, T0 + MIN, 'C', { fromMe: true })], T0 + 2 * MIN, limits);
assert.strictEqual(f.closed.length, 0, 'still within the quiet window');
assert.strictEqual(Object.keys(f.open).length, 1);
assert.strictEqual(f.open['chat:iMessage;-;+14255550100'].lines.length, 2);

// --- quiet closes it on a LATER tick with no new rows ------------------
f = S.fold(f.open, [], T0 + 12 * MIN, limits);
assert.strictEqual(f.closed.length, 1, 'quiet window elapsed');
assert.strictEqual(Object.keys(f.open).length, 0);
assert.strictEqual(f.closed[0].lines.length, 2);

// --- a gap inside a backlog splits conversations ------------------------
f = S.fold({}, [
    row(1, T0, 'Your package arrives tomorrow'),
    row(2, T0 + 30 * MIN, 'Out for delivery now'),
    row(3, T0 + 31 * MIN, 'Delivered. Left at the door', { att: true }),
], T0 + 32 * MIN, limits);
assert.strictEqual(f.closed.length, 1, 'the first text closed at the gap');
assert.deepStrictEqual(f.closed[0].lines.map(l => l.rowid), [1]);
assert.deepStrictEqual(f.open['chat:iMessage;-;+14255550100'].lines.map(l => l.rowid), [2, 3], 'the recent pair is still open');

// --- the line cap closes at once ----------------------------------------
f = S.fold({}, [1, 2, 3, 4, 5, 6].map(i => row(i, T0 + i * 1000, `line ${i}`)), T0 + 10 * 1000, limits);
assert.strictEqual(f.closed.length, 1);
assert.strictEqual(f.closed[0].lines.length, 5, 'closed at MAX_LINES');
assert.strictEqual(f.open['chat:iMessage;-;+14255550100'].lines.length, 1, 'the sixth starts the next');

// --- only my own texts: never a record -----------------------------------
f = S.fold({}, [row(1, T0, 'remember milk', { fromMe: true }), row(2, T0 + MIN, 'and eggs', { fromMe: true })], T0 + 20 * MIN, limits);
assert.strictEqual(f.closed.length, 0, 'own texts alone are not incoming');
assert.strictEqual(Object.keys(f.open).length, 0, 'and the buffer is gone, not stuck');

// --- empty / undecodable text is skipped; chats are kept apart ---------
f = S.fold({}, [
    row(1, T0, ''),
    row(2, T0, 'Practice moved to 5pm Saturday', { chatId: 2, chatGuid: 'iMessage;+;chat123', chatIdentifier: 'chat123', chatName: 'Soccer parents', isGroup: true, handle: '+14255550111' }),
    row(3, T0 + MIN, 'ok', { chatId: 2, chatGuid: 'iMessage;+;chat123', chatIdentifier: 'chat123', chatName: 'Soccer parents', isGroup: true, fromMe: true, handle: '' }),
], T0 + 20 * MIN, limits);
assert.strictEqual(f.closed.length, 1);
const grp = f.closed[0];
assert.strictEqual(grp.chat.isGroup, true);
assert.strictEqual(grp.chat.name, 'Soccer parents');
assert.strictEqual(grp.chat.handle, '', 'a group has no single handle');

// --- buildRecord: shape --------------------------------------------------
let rec = S.buildRecord(grp, null, limits);
assert.strictEqual(rec.messageId, 'imsg:g3', 'id is the LAST line’s guid');
assert.strictEqual(rec.id, rec.messageId);
assert.strictEqual(rec.source, 'imessage');
assert.strictEqual(rec.account, 'imessage');
assert.strictEqual(rec.from, 'Soccer parents <group:chat123>');
assert.strictEqual(rec.subject, 'Practice moved to 5pm Saturday', 'subject = first incoming line');
assert.deepStrictEqual(rec.labels, ['INBOX'], 'reads as incoming to the engine');
assert.strictEqual(rec.bodyHtml, '');
assert.ok(/\+14255550111: Practice moved to 5pm Saturday/.test(rec.bodyText), 'group lines name the sender handle');
assert.ok(/Me: ok/.test(rec.bodyText), 'own lines read as Me');
assert.strictEqual(rec.date, iso(T0 + MIN));
assert.strictEqual(rec.internalDate, T0 + MIN);
assert.strictEqual(rec.lines.length, 2);
assert.strictEqual(rec.hasAttachment, false);

// one-to-one: label is the handle, addr is the handle (Follow/Mute key)
const one = S.fold({}, [row(1, T0, 'Your table for 2 is confirmed for Sep 12 at 7pm, code RZ44')], T0 + 20 * MIN, limits).closed[0];
rec = S.buildRecord(one, null, limits);
assert.strictEqual(rec.from, '+14255550100 <+14255550100>');
assert.strictEqual(rec.subject.length <= 40, true, 'subject capped');
assert.ok(rec.subject.endsWith('…'));

// --- context from the previous record rides along, flagged ----------------
const prev = rec; // the reservation text
const next = S.fold({}, [row(9, T0 + 60 * MIN, 'Can you make it 7:30 instead?'), row(10, T0 + 61 * MIN, 'yes', { fromMe: true })], T0 + 90 * MIN, limits).closed[0];
rec = S.buildRecord(next, prev, limits);
assert.strictEqual(rec.messageId, 'imsg:g10');
assert.ok(rec.bodyText.startsWith('(earlier in this conversation)\n'), 'context block leads');
assert.ok(/\(new messages\)\n\[.*\] \+14255550100: Can you make it 7:30 instead\?/.test(rec.bodyText));
assert.strictEqual(rec.lines[0].context, true, 'context lines are flagged for the transcript');
assert.strictEqual(rec.lines.filter(l => !l.context).length, 2);
// context never chains: a third record takes the SECOND's own lines only
const third = S.fold({}, [row(20, T0 + 200 * MIN, 'See you at 7:30')], T0 + 300 * MIN, limits).closed[0];
const rec3 = S.buildRecord(third, rec, limits);
assert.strictEqual(rec3.lines.filter(l => l.context).length, 2, 'only the previous record’s own two lines');
assert.ok(!/Your table for 2/.test(rec3.bodyText), 'the grand-parent conversation does not chain in');

// --- body cap keeps the NEW end ------------------------------------------
const longChunk = S.fold({}, [row(1, T0, 'A'.repeat(2000)), row(2, T0 + MIN, 'B'.repeat(2000))], T0 + 20 * MIN, limits).closed[0];
rec = S.buildRecord(longChunk, null, { ...limits, BODY_CHARS: 2500 });
assert.ok(rec.bodyText.length <= 2500);
assert.ok(rec.bodyText.startsWith('…'));
assert.ok(/B{2000}$/.test(rec.bodyText), 'the newest line survives whole');

// --- no incoming text → null, never a record ----------------------------
assert.strictEqual(S.buildRecord({ chat: {}, lines: [{ text: 'x', fromMe: true, at: T0, guid: 'g' }] }, null, limits), null);
assert.strictEqual(S.buildRecord({ chat: {}, lines: [] }, null, limits), null);

console.log('imessage-source-test: OK');
