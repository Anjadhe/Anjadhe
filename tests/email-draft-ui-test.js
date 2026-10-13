const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<body></body>');
let copied;
const ctx = vm.createContext({ document: dom.window.document, console,
    navigator: { clipboard: { writeText: async text => { copied = text; } } },
    setTimeout: () => {}, AnswerBlocks: require('../js/components/answer-blocks') });
vm.runInContext(fs.readFileSync('js/agent/agent-ui.js', 'utf8') + '\nthis.UI = AgentUI;', ctx);
const UI = ctx.UI;
const body = 'Hi Ram,\n\nThis week — Oct 7–12, 2026:\n– 2:00–3:00 PM — Weekly review\n\nThanks,\nRam';
const headers = 'To: ram@example.com\nSubject: This week’s schedule — Oct 7–12';
function render(text) {
    dom.window.document.body.innerHTML = '<div class="agent-bubble">' + UI.formatContent(text) + '</div>';
    return dom.window.document;
}
for (const message of [
    '```email\n' + headers + '\n\n' + body + '\n```',
    '**To:** ram@example.com\n**Subject:** This week’s schedule — Oct 7–12\n\n```\n' + body + '\n```',
    '**To**: ram@example.com\n\n**Subject**: This week’s schedule — Oct 7–12\n\n```text\n' + body + '\n```',
    headers + '\n\n' + body.split('\n').map(line => '> ' + line).join('\n'),
]) {
    const doc = render('Here is the draft.\n\n' + message + '\n\nA note outside the email.');
    assert.equal(doc.querySelectorAll('.agent-email-draft').length, 1);
    assert.equal(doc.querySelector('.agent-email-body').textContent, body);
    assert.equal(doc.querySelector('.agent-email-subject').textContent, 'This week’s schedule — Oct 7–12');
    assert.equal(doc.querySelector('pre'), null);
    assert.ok(!doc.querySelector('.agent-email-draft').textContent.includes('A note outside'));
    UI._installCopyHandlers();
    doc.querySelector('.agent-email-copy').click();
    assert.equal(copied, body, 'copy is the exact message, without headers or commentary');
}
let doc = render('```email\n' + headers + '\nCc: sam@example.com\nBcc: pat@example.com\n\n<img src=x onerror="bad()"> & **literal**\n```');
assert.equal(doc.querySelectorAll('.agent-email-recipient').length, 3);
assert.equal(doc.querySelector('img'), null);
assert.equal(doc.querySelector('.agent-email-body').textContent, '<img src=x onerror="bad()"> & **literal**');
doc = render('```email\nTo: <img src=x>\nSubject: <script>bad()</script>\n\nBody\n```');
assert.equal(doc.querySelector('img, script'), null, 'headers are escaped too');
doc = render('````email\n' + headers + '\n\nLiteral code:\n```js\nconst x = 1;\n```\n````');
assert.equal(doc.querySelector('.agent-email-body').textContent, 'Literal code:\n```js\nconst x = 1;\n```');
doc = render('```email\n' + headers + '\n\nHi Ram,');
assert.equal(doc.querySelector('.agent-email-body').textContent, 'Hi Ram,', 'streaming draft uses same card');
doc = render('```email\n' + headers + '\n\nSubject: a line in the message\n\nBody\n```');
assert.equal(doc.querySelector('.agent-email-body').textContent, 'Subject: a line in the message\n\nBody');
for (const text of ['```js\n' + headers + '\n```', headers + '\n\nJust prose.', '```email\nSubject: Missing recipient\n\nHello\n```']) {
    assert.equal(render(text).querySelector('.agent-email-draft'), null, 'unrelated/incomplete content stays Markdown');
}
console.log('email-draft-ui: legacy and new drafts, streaming, copy, escaping and code preservation passed');
