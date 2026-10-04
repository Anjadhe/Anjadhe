// Pins js/main/mcp-args.js — MCP call arguments adjusted in main.
const assert = require('assert');
const { prepareToolArgs } = require('../js/main/mcp-args.js');

// A screenshot always comes back as an image: the filename is dropped.
const shot = { filename: 'mac-neo-results.png', scale: 'css', fullPage: false };
assert.deepStrictEqual(prepareToolArgs('browser_take_screenshot', shot), { scale: 'css', fullPage: false });
assert.strictEqual(shot.filename, 'mac-neo-results.png', 'the caller\'s object is not mutated');
assert.deepStrictEqual(prepareToolArgs('browser_take_screenshot', { type: 'jpeg' }), { type: 'jpeg' });

// Everything else passes through untouched.
const other = { filename: 'report.pdf' };
assert.strictEqual(prepareToolArgs('browser_pdf_save', other), other);
assert.deepStrictEqual(prepareToolArgs('browser_navigate', { url: 'https://example.com' }), { url: 'https://example.com' });
assert.deepStrictEqual(prepareToolArgs('browser_snapshot', undefined), {});
assert.deepStrictEqual(prepareToolArgs('browser_take_screenshot', null), {});

console.log('mcp-args-test: ok');
