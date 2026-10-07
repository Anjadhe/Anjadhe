#!/usr/bin/env node
// WellnessFold (js/core/wellness-fold.js): the health log becomes
// commitments — one open "Track …" per kind holding its days' words, one
// daily "Take <name>" per medication with each logged day marked done; one
// write, idempotent, nothing model-written.
const assert = require('assert');
const C = require('../js/core/commitments.js');
const F = require('../js/core/wellness-fold.js');
let store = null;
global.StorageManager = { get: k => (k === C.KEY ? store : null), set: (k, v) => { if (k === C.KEY) store = JSON.parse(JSON.stringify(v)); } };
C._data = null;

const blob = {
    settings: { units: { weight: 'kg', glucose: 'mg/dL', temperature: 'F', water: 'oz', distance: 'mi' } },
    entries: [
        { id: 'e1', kind: 'bp', time: '2026-09-02T07:10', systolic: 128, diastolic: 82, pulse: 70, notes: 'after morning walk' },
        { id: 'e2', kind: 'bp', time: '2026-09-02T21:00', systolic: 122, diastolic: 80 },
        { id: 'e3', kind: 'weight', time: '2026-09-03T06:30', value: 72.4 },
        { id: 'e4', kind: 'medication', time: '2026-09-02T08:00', name: 'Amlodipine', dose: '5 mg' },
        { id: 'e5', kind: 'medication', time: '2026-09-03T08:05', name: 'Amlodipine', dose: '5 mg' },
        { id: 'e6', kind: 'activity', time: '2026-09-03T18:00', activityType: 'Walk', duration: 30, distance: 2, avgBpm: 120 },
        { id: 'e7', kind: 'sleep', time: '2026-09-04', hours: 7.5, quality: 'Good' },
        { id: 'e8', kind: 'mood', time: '2026-09-04T09:00', mood: 'Good', energy: 'Okay', stress: 'Mild' },
        { id: 'e9', kind: 'meal', time: '2026-09-04T12:30', mealType: 'Lunch', description: 'dal and rice' },
        { id: 'e10', kind: 'water', time: '2026-09-04T13:00', amount: 8 },
        { id: 'e11', kind: 'glucose', time: '2026-09-04T07:00', value: 95, context: 'Fasting' },
        { id: 'e12', kind: 'symptom', time: '2026-09-04T15:00', name: 'headache', severity: 'Moderate' },
        { id: 'e13', kind: 'note', time: '2026-09-04T16:00', notes: 'new medication started today' },
        { id: 'bad1', kind: 'bp', time: 'nope' },
        { id: 'bad2', kind: 'unicorn', time: '2026-09-04T16:00' },
        { id: 'bad3', kind: 'bp', time: '2026-09-05T07:00' },   // nothing to say
        null
    ]
};

// ── The words are the entry's own fields ──
{
    const { lines, skipped } = F.lines(blob);
    assert.equal(skipped, 4);
    const by = Object.fromEntries(lines.map(l => [l.quote, l]));
    assert.ok(by['7:10 AM: 128/82, pulse 70 — after morning walk'], 'BP with pulse and notes');
    assert.equal(by['7:10 AM: 128/82, pulse 70 — after morning walk'].id, 'wellness-bp');
    assert.ok(by['9:00 PM: 122/80']);
    assert.ok(by['6:30 AM: 72.4 kg'], 'the unit follows Settings › Units');
    assert.equal(by['8:00 AM: 5 mg'].id, 'wellness-med-amlodipine');
    assert.equal(by['8:00 AM: 5 mg'].title, 'Take Amlodipine');
    assert.ok(by['6:00 PM: Walk, 30 min, 2 mi, avg 120 bpm']);
    assert.ok(by['7.5 h, good'], 'a date-only entry has no clock');
    assert.ok(by['9:00 AM: mood good, energy okay, stress mild']);
    assert.ok(by['12:30 PM: Lunch: dal and rice']);
    assert.ok(by['1:00 PM: 8 oz']);
    assert.ok(by['7:00 AM: 95 mg/dL, fasting']);
    assert.ok(by['3:00 PM: headache, moderate']);
    assert.ok(by['4:00 PM: new medication started today']);
    assert.ok(lines.every((l, i) => i === 0 || lines[i - 1].day <= l.day), 'oldest first');
}

// ── One write; readings open and undated, medications daily and done ──
{
    const r = F.apply(blob, C, Date.parse('2026-10-05T10:00:00'));
    assert.equal(r.reports, 13);
    assert.equal(r.created.length, 11);
    const bp = C.get('wellness-bp');
    assert.equal(bp.title, 'Track blood pressure');
    assert.equal(bp.repeat.rule, 'none', 'a reading taken now and then is not a daily row on Today');
    assert.equal(bp.when, null);
    assert.equal(bp.state, 'open');
    assert.equal(bp.log['2026-09-02'].length, 2, 'both readings on their day');
    assert.ok(!bp.history || !bp.history['2026-09-02'], 'an undated commitment carries no day marks');
    const med = C.get('wellness-med-amlodipine');
    assert.equal(med.repeat.rule, 'daily');
    assert.equal(med.when.date, '2026-09-02', 'from the first day it was taken');
    assert.equal(med.history['2026-09-02'], 'done');
    assert.equal(med.history['2026-09-03'], 'done');
    assert.ok(C.occursOn(med, '2026-10-05'));
    const ledger = C._load().ledger;
    assert.equal(ledger.length, 1, 'ONE ledger entry');
    assert.equal(ledger[0].op, 'fold');
    assert.ok(store, 'saved');

    // Again: nothing new.
    const again = F.apply(blob, C, Date.parse('2026-10-05T11:00:00'));
    assert.equal(again.reports, 0); assert.equal(again.created.length, 0);
    assert.equal(C._load().ledger.length, 1, 'no second ledger entry for nothing');

    // A later reading said in chat lands through the same door.
    const rep = C.report('wellness-bp', { day: '2026-10-05', quote: 'BP 130/85 this morning' }, { by: 'assistant' });
    assert.ok(rep.ok, rep.error);
    assert.equal(C.get('wellness-bp').log['2026-10-05'][0].quote, 'BP 130/85 this morning');
    assert.equal(C.get('wellness-bp').state, 'open', 'a report with no mark leaves it open');
}

// ── An empty or missing log folds nothing ──
{
    assert.equal(F.lines(null).lines.length, 0);
    assert.equal(F.apply({ entries: [] }, C).reports, 0);
}

console.log('wellness-fold: ok');
