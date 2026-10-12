/* browser_look / browser_act as the MODEL meets them: what a look reads as,
 * what a bad call is told, one step per turn, a playbook on first arrival. */
const assert = require('node:assert/strict');
globalThis.Playbooks = require('../js/agent/specialists/playbooks');
const BrowserTools = require('../js/agent/specialists/browser-tools');
(async () => {
    const [lookDef, actDef] = BrowserTools.definitions();
    assert.deepEqual([lookDef.function.name, actDef.function.name], ['browser_look', 'browser_act'], 'Two verbs');
    assert.deepEqual(actDef.function.parameters.properties.action.enum, BrowserTools.ACTIONS);
    assert.ok(!/seat|movie|showtime|imax/i.test(JSON.stringify([lookDef, actDef])), 'The tools know nothing about any kind of site');

    // A bad call is told what is wrong, so the next one fixes itself.
    assert.match(BrowserTools.checkArgs({ action: 'scroll', y: 3500 }), /does not take .y./);
    assert.match(BrowserTools.checkArgs({ action: 'click' }), /click needs .n./);
    assert.match(BrowserTools.checkArgs({ action: 'open', url: 'fandango.com' }), /https:\/\//);
    assert.match(BrowserTools.checkArgs({ action: 'press', key: 'F5' }), /press takes one of/);
    assert.match(BrowserTools.checkArgs({ action: 'hover', n: 1 }), /needs an action/);
    assert.equal(BrowserTools.checkArgs({ action: 'type', n: 3, text: 'kettle', submit: true }), null);
    assert.equal(BrowserTools.checkArgs({ action: 'type', n: 3, text: '' }), 'browser_act type needs “text”.');

    // A look is short lines, not JSON rows.
    const look = { url: 'https://www.fandango.com/x', title: 'Tickets', elements: [
        { n: 1, role: 'input', label: 'Search', type: 'search', placeholder: 'Movies, theaters', x: 0, y: 0, w: 10, h: 10 },
        { n: 2, role: 'button', label: 'Check Seats', near: 'The Odyssey', x: 0, y: 0, w: 10, h: 10 },
        { n: 3, role: 'input', label: 'Password', type: 'password', manualOnly: true },
        { n: 4, role: 'select', label: 'Theater', type: 'select-one', value: 'Dublin CA', options: ['New York', 'Dublin CA'] },
        { n: 5, role: 'a', label: 'Help', href: 'https://www.fandango.com/help/center?ref=1' },
        { n: 6, role: 'checkbox', label: 'Remember', type: 'checkbox', checked: false }],
        more: { above: 2, below: 40 }, scroll: { y: 800, viewport: 800, height: 6400 }, text: 'The Odyssey 7:10p', images: [{ dataUrl: 'data:image/jpeg;base64,AA' }], waitedMs: 1200 };
    const out = BrowserTools.format(look, { playbook: '- a note' });
    assert.equal(out.controls.split('\n')[0], '[1] input “Search” (Movies, theaters)');
    assert.equal(out.controls.split('\n')[1], '[2] button “Check Seats” (under “The Odyssey”)');
    assert.match(out.controls.split('\n')[2], /user only/);
    assert.match(out.controls.split('\n')[3], /= “Dublin CA” options: New York \| Dublin CA/);
    assert.match(out.controls.split('\n')[4], /→ fandango\.com\/help\/center$/);
    assert.match(out.controls.split('\n')[5], /☐/);
    assert.equal(out.position, 'Screen 2 of 8. 2 controls above, 40 below.');
    assert.equal(out.notes, '- a note'); assert.equal(out.waitedMs, 1200); assert.equal(out.images.length, 1);
    assert.ok(JSON.stringify({ ...out, images: undefined }).length < 900, 'Six controls cost a few hundred characters');
    assert.equal(out.elements, undefined, 'Pixel rects and raw rows never reach the model');
    // What a step did is said in the result the model reads.
    assert.match(BrowserTools.format({ ...look, step: { ok: true, found: 0 } }).found, /not on this page/);
    assert.match(BrowserTools.format({ ...look, step: { ok: true, moved: false } }).note, /did not scroll/);
    assert.match(BrowserTools.format({ ...look, step: { error: 'Control 9 is disabled.' } }).stepError, /disabled/);
    assert.match(BrowserTools.format({ ...look, images: undefined, imageError: 'too large' }).picture, /No picture this time/);
    assert.deepEqual(BrowserTools.format({ error: 'The user did not allow this step.', denied: true, waitedMs: 5 }), { error: 'The user did not allow this step.', denied: true, waitedMs: 5 });

    // Through the tool: lease required, one step per turn, playbook once.
    const sent = [];
    globalThis.window = { electronAgentBrowser: { command: async (action, input) => { if (action === 'execute') { sent.push(input); return look; } return { connected: true }; } } };
    assert.match((await BrowserTools.run('look', {}, {})).error, /Only a Browser agent in a workroom/);
    const workroom = { id: 'r', token: 't', vision: true, tainted: true, seen: new Set(), acted: null };
    let result = await BrowserTools.run('act', { action: 'click', n: '2' }, { workroom, step: 0 });
    assert.deepEqual(sent[0], { action: 'act', args: { action: 'click', n: 2 }, run: { id: 'r', token: 't' }, image: true, tainted: true });
    assert.match(result.notes, /Check Seats/, 'The site\'s playbook rides the first look that lands on it');
    result = await BrowserTools.run('act', { action: 'click', n: 5 }, { workroom, step: 0 });
    assert.match(result.error, /One step at a time/); assert.equal(sent.length, 1, 'Numbers belong to one look');
    result = await BrowserTools.run('act', { action: 'click', n: 5 }, { workroom, step: 1 });
    assert.equal(result.notes, undefined, 'A playbook is said once');
    result = await BrowserTools.run('act', { action: 'scroll', y: 1 }, { workroom, step: 2 });
    assert.match(result.error, /does not take/); assert.equal(sent.length, 2, 'A malformed step never reaches the browser');
    console.log('browser-specialist-test passed');
})().catch(error => { console.error(error); process.exit(1); });
