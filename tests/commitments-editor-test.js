#!/usr/bin/env node
// The commitment sheet's field editor saves on every way off it
// (js/apps/commitments/commitments-page.js, "The field editor saves
// itself"): Enter in a date/time/text field, a pick in a select, a submit.
// Enter used to close the editor BEFORE saving, so a new time was lost.
const path = '../';
const assert = require('assert');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body><div id="app-views"></div></body>');
Object.assign(global, { window: dom.window, document: dom.window.document, FormData: dom.window.FormData, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, HTMLElement: dom.window.HTMLElement });
const C = require(path + 'js/core/commitments.js');
let store = null;
global.StorageManager = { get: k => (k === C.KEY ? store : null), set: (k, v) => { if (k === C.KEY) store = JSON.parse(JSON.stringify(v)); } };
global.Commitments = C; C._inited = true;
global.FEATURES = { isEnabled: () => true };
global.AppManager = { currentApp: 'commitments', register() {}, openAppFromLauncher() {} };
const toasts = []; global.UIUtils = { showToast: (m, t) => toasts.push([t, m]) };
const P = require(path + 'js/apps/commitments/commitments-page.js');
const r = C.create({ title: 'Dentist', when: { date: '2026-10-20', time: '09:00' } });
P.open(r.id); P._details = true;
const q = s => document.querySelector('#commitments-view ' + s);
const edit = f => { P._editing = f; P.render(); return q('.cm-editor'); };
const enter = el => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
const change = el => el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

let f = edit('when'); f.querySelector('[name=time]').value = '14:30'; enter(f.querySelector('[name=time]'));
assert.equal(C.get(r.id).when.time, '14:30', 'Enter saves the time'); assert.equal(P._editing, null, 'and closes');
f = edit('when'); f.querySelector('[name=date]').value = '2026-10-22'; enter(f.querySelector('[name=date]'));
assert.equal(C.get(r.id).when.date, '2026-10-22', 'Enter saves the date');
f = edit('when'); f.querySelector('[name=end]').value = '15:30'; enter(f.querySelector('[name=end]'));
assert.equal(C.get(r.id).when.end, '15:30', 'Enter saves the end time');
f = edit('by'); f.querySelector('[name=by]').value = '2026-10-30'; enter(f.querySelector('[name=by]'));
assert.equal(C.get(r.id).by, '2026-10-30', 'Enter saves by');
f = edit('outcome'); f.querySelector('[name=outcome]').value = 'Teeth cleaned'; enter(f.querySelector('[name=outcome]'));
assert.equal(C.get(r.id).outcome, 'Teeth cleaned', 'Enter saves outcome');
f = edit('waiting'); f.querySelector('[name=who]').value = 'Dr Lee'; enter(f.querySelector('[name=who]'));
assert.equal(C.get(r.id).waitingOn.who, 'Dr Lee', 'Enter saves waiting on');
f = edit('remind'); f.querySelector('[name=remind]').value = 'm30'; change(f.querySelector('[name=remind]'));
assert.equal(C.get(r.id).remind.minutesBefore, 30, 'a pick saves the reminder');
f = edit('repeat'); f.querySelector('[name=rule]').value = 'daily'; change(f.querySelector('[name=rule]'));
assert.equal(C.get(r.id).repeat.rule, 'daily', 'a pick saves repeat');
f = edit('outcome'); f.querySelector('[name=outcome]').value = 'Via submit'; f.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
assert.equal(C.get(r.id).outcome, 'Via submit', 'submit saves');
f = edit('outcome'); f.querySelector('[name=outcome]').value = 'Discarded'; f.querySelector('[name=outcome]').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
assert.equal(C.get(r.id).outcome, 'Via submit', 'Escape discards');
console.log("commitments-editor: passed");
