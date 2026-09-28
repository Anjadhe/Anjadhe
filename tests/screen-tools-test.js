/**
 * Screen tools — the pure halves (docs/COWORK_AGENT.md C13):
 * main's input validation (the boundary) and the renderer's vocabulary,
 * element-list budget and consent line.
 *
 *   node tests/screen-tools-test.js
 */
const assert = require('assert');
const path = require('path');

const { normalizeInput, parseKey, MAX_TEXT } = require(path.join(__dirname, '../js/main/screen-control.js'));
const ScreenTools = require(path.join(__dirname, '../js/agent/screen-tools.js'));

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const VP = { width: 1440, height: 900 };

// ── main: keys ───────────────────────────────────────────────────────────
test('named keys normalize', () => {
    assert.deepStrictEqual(parseKey('Enter'), { keyCode: 'Enter', modifiers: [] });
    assert.deepStrictEqual(parseKey('esc'), { keyCode: 'Escape', modifiers: [] });
    assert.deepStrictEqual(parseKey('ArrowDown'), { keyCode: 'Down', modifiers: [] });
    assert.deepStrictEqual(parseKey('page down'.replace(' ', '')), { keyCode: 'PageDown', modifiers: [] });
});
test('modifier combos normalize in a fixed order', () => {
    assert.deepStrictEqual(parseKey('Shift + CMD + a'), { keyCode: 'a', modifiers: ['meta', 'shift'] });
    assert.deepStrictEqual(parseKey('option+tab'), { keyCode: 'Tab', modifiers: ['alt'] });
});
test('combos that close, hide or reload the app are refused', () => {
    for (const k of ['cmd+q', 'CMD+W', 'cmd+r', 'shift+cmd+r', 'cmd+m', 'cmd+h', 'cmd+option+i', 'ctrl+r']) {
        assert.ok(parseKey(k).error, `${k} should be refused`);
    }
});
test('unknown keys and modifiers are refused with a readable reason', () => {
    assert.match(parseKey('F13').error, /Unsupported key/);
    assert.match(parseKey('hyper+a').error, /Unknown modifier/);
    assert.ok(parseKey('').error);
    assert.ok(parseKey('a+b+c+d+e').error);
});

// ── main: input steps ────────────────────────────────────────────────────
test('click inside the viewport passes; outside or NaN is refused', () => {
    assert.deepStrictEqual(normalizeInput({ type: 'click', x: 10, y: 20 }, VP), { type: 'click', x: 10, y: 20 });
    assert.ok(normalizeInput({ type: 'click', x: 1441, y: 20 }, VP).error);
    assert.ok(normalizeInput({ type: 'click', x: -1, y: 20 }, VP).error);
    assert.ok(normalizeInput({ type: 'click', x: 'a', y: 20 }, VP).error);
});
test('text is bounded and must be a non-empty string', () => {
    assert.deepStrictEqual(normalizeInput({ type: 'type', text: 'hi' }, VP), { type: 'type', text: 'hi' });
    assert.ok(normalizeInput({ type: 'type', text: '' }, VP).error);
    assert.ok(normalizeInput({ type: 'type', text: 42 }, VP).error);
    assert.ok(normalizeInput({ type: 'type', text: 'x'.repeat(MAX_TEXT + 1) }, VP).error);
});
test('key steps carry the parsed key; unknown step types are refused', () => {
    assert.deepStrictEqual(normalizeInput({ type: 'key', key: 'cmd+a' }, VP), { type: 'key', keyCode: 'a', modifiers: ['meta'] });
    assert.ok(normalizeInput({ type: 'key', key: 'cmd+q' }, VP).error);
    assert.ok(normalizeInput({ type: 'drag' }, VP).error);
    assert.ok(normalizeInput(null, VP).error);
});

// ── renderer: vocabulary ─────────────────────────────────────────────────
test('screen asks summon the group', () => {
    for (const s of [
        'take a screenshot and tell me what you see',
        'what do you see on my screen?',
        'click the Save button',
        'press enter',
        'scroll down the task list',
        'fill in the title field with Groceries',
        'can you use the app to add this',
        'do it in the app for me'
    ]) assert.ok(ScreenTools.domainMatch(s), s);
});
test('ordinary asks do not', () => {
    for (const s of [
        'what is on my calendar tomorrow',
        'summarize my notes about the trip',
        'add a task to buy milk',
        'build me a quick tracker'
    ]) assert.ok(!ScreenTools.domainMatch(s), s);
});

// ── renderer: element list ───────────────────────────────────────────────
test('element lines carry role, label, state and a non-page region', () => {
    const { text, shown } = ScreenTools.formatElements([
        { n: 1, role: 'link', label: 'Tasks', state: 'current', region: 'left nav' },
        { n: 2, role: 'button', label: '', state: '', region: 'page' }
    ], 1000);
    assert.strictEqual(shown, 2);
    assert.strictEqual(text, '[1] link: Tasks (current) — left nav\n[2] button: (no label)');
});
test('a repeated label carries its row title', () => {
    const { text } = ScreenTools.formatElements([
        { n: 3, role: 'button', label: 'Done', context: 'Pay the credit card bill', state: '', region: 'page' }
    ], 1000);
    assert.strictEqual(text, '[3] button: Done — for "Pay the credit card bill"');
});
test('the list stops on a whole line inside the budget', () => {
    const marks = Array.from({ length: 50 }, (_, i) => ({ n: i + 1, role: 'button', label: 'Label number ' + i, state: '', region: 'page' }));
    const { text, shown } = ScreenTools.formatElements(marks, 200);
    assert.ok(text.length <= 200);
    assert.ok(shown > 0 && shown < 50);
    assert.strictEqual(text.split('\n').length, shown);
    assert.ok(/^\[\d+\] button: Label number \d+$/.test(text.split('\n').pop()));
});
test('labels collapse whitespace and cap length', () => {
    assert.strictEqual(ScreenTools.cleanLabel('  a \n\t b  '), 'a b');
    assert.strictEqual(ScreenTools.cleanLabel('x'.repeat(80), 10), 'x'.repeat(9) + '…');
});

// ── renderer: consent line ───────────────────────────────────────────────
test('consent line names the element from the latest look, escaped', () => {
    ScreenTools._marks = [{ n: 4, role: 'button', label: 'Delete <b>all</b>', region: 'dialog' }];
    ScreenTools._appLabel = () => 'Notes';
    const html = ScreenTools.describeAct({ action: 'click', element: 4 });
    assert.ok(html.includes('Delete &lt;b&gt;all&lt;/b&gt;'), html);
    assert.ok(html.includes('dialog') && html.includes('in Notes'), html);
    assert.ok(ScreenTools.describeAct({ action: 'type', text: 'hello', element: 4, clear: true }).includes('replacing'));
    assert.ok(ScreenTools.describeAct({ action: 'press', key: '<cmd+a>' }).includes('&lt;cmd+a&gt;'));
});
test('outside-content taint is per conversation', () => {
    ScreenTools._outsideConvs.clear();
    ScreenTools._outsideConvs.add('conv_a');
    assert.ok(ScreenTools.sawOutsideContent('conv_a'));
    assert.ok(!ScreenTools.sawOutsideContent('conv_b'));
});

console.log(`screen-tools: ${passed} passed${process.exitCode ? ', with failures' : ''}`);
