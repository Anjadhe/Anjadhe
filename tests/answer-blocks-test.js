// Pins js/components/answer-blocks.js — the pure half (parse, formats,
// sorting, normalize, render to HTML strings) runs in plain Node. Laws
// B1–B5 head the component; the ones a test can hold are held here.
const assert = require('assert');
const AnswerBlocks = require('../js/components/answer-blocks.js');

// ── parse: the fence body is a view name plus sort/limit ───────────────
assert.deepStrictEqual(AnswerBlocks.parse('holdings'), { id: 'holdings' });
assert.deepStrictEqual(AnswerBlocks.parse('  Holdings sort=-value limit=5 '), { id: 'holdings', sort: '-value', limit: 5 });
assert.deepStrictEqual(AnswerBlocks.parse('view=stats'), { id: 'stats' });
assert.deepStrictEqual(AnswerBlocks.parse('&quot;holdings&quot;'), { id: 'holdings' }, 'escaped quotes around the name are ignored');
assert.strictEqual(AnswerBlocks.parse(''), null);
assert.strictEqual(AnswerBlocks.parse('sort=-value'), null, 'no view name → nothing');
assert.strictEqual(AnswerBlocks.parse('holdings limit=999').limit, AnswerBlocks.MAX_ROWS, 'limit is capped');

// ── lift: the fence comes out before the Markdown scan, slips forgiven ──
const PH = (n) => `\x00AB${n}\x00`;
let L = AnswerBlocks.lift('Intro\n```nenva\nstats\n```\nOutro');
assert.strictEqual(L.text, `Intro\n${PH(0)}\nOutro`);
assert.deepStrictEqual(L.blocks, ['stats']);
L = AnswerBlocks.lift('```\n```nenva\nstats\n```\n```\nProse stays prose.');
assert.strictEqual(L.text, `${PH(0)}\nProse stays prose.`, 'a fence wrapped in a bare fence loses the wrapper');
L = AnswerBlocks.lift('```nenva\nstats\n```\n```\nProse stays prose.');
assert.strictEqual(L.text, `${PH(0)}\nProse stays prose.`, 'a doubled closer is dropped');
L = AnswerBlocks.lift('```nenva\n```nenva\nholdings sort=-value\n```\nAfter');
assert.strictEqual(L.text, `${PH(0)}\nAfter`, 'a nested nenva fence is one block');
assert.deepStrictEqual(AnswerBlocks.parse(L.blocks[0]), { id: 'holdings', sort: '-value' }, 'the stray backtick token is skipped');
L = AnswerBlocks.lift('See ```nenva stats``` here.');
assert.strictEqual(L.text, `See ${PH(0)} here.`, 'the one-line form lifts too');
L = AnswerBlocks.lift('A\n```nenva\nstats\n```\nB\n```nenva\nvalue\n```\nC\n```js\nconst x = 1;\n```');
assert.strictEqual(L.text, `A\n${PH(0)}\nB\n${PH(1)}\nC\n\`\`\`js\nconst x = 1;\n\`\`\``, 'other code fences are left alone');
assert.deepStrictEqual(L.blocks, ['stats', 'value']);
L = AnswerBlocks.lift('No blocks here\n```js\nx\n```');
assert.deepStrictEqual(L.blocks, []);
assert.strictEqual(AnswerBlocks.unlift(PH(0), ['stats']), '```nenva\nstats\n```');
assert.ok(AnswerBlocks.PLACEHOLDER_RX.test('  ' + PH(3) + ' '));
assert.ok(!AnswerBlocks.PLACEHOLDER_RX.test('text ' + PH(3)));
L = AnswerBlocks.lift('```nenva\nstats');
assert.deepStrictEqual(L.blocks, [], 'an unterminated fence (still streaming) is left for the scanner');

// ── formatValue: code formats, with the sign only where asked (B3) ─────
assert.strictEqual(AnswerBlocks.formatValue(12345.6, 'money'), '$12,346');
assert.strictEqual(AnswerBlocks.formatValue(-250, 'money'), '−$250');
assert.strictEqual(AnswerBlocks.formatValue(250, 'money', true), '+$250');
assert.strictEqual(AnswerBlocks.formatValue(0, 'money', true), '$0');
assert.strictEqual(AnswerBlocks.formatValue(187.5, 'money2'), '$187.50');
assert.strictEqual(AnswerBlocks.formatValue(12.34, 'pct'), '12.3%');
assert.strictEqual(AnswerBlocks.formatValue(-3.2, 'pct', true), '−3.2%');
assert.strictEqual(AnswerBlocks.formatValue(1.5, 'shares'), '1.5');
assert.strictEqual(AnswerBlocks.formatValue('AAPL', 'text'), 'AAPL');
assert.strictEqual(AnswerBlocks.formatValue('2026-04-09', 'date'), new Date(2026, 3, 9).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), 'a bare day is a local day');
assert.strictEqual(AnswerBlocks.formatValue(null, 'money'), '');
assert.strictEqual(AnswerBlocks.formatValue('n/a', 'money'), 'n/a', 'a non-number passes through unformatted');
assert.strictEqual(AnswerBlocks.tone(5, true), ' is-up');
assert.strictEqual(AnswerBlocks.tone(-5, true), ' is-down');
assert.strictEqual(AnswerBlocks.tone(-5, false), '', 'an unsigned value is ink');
assert.strictEqual(AnswerBlocks.tone(0, true), '');

// ── sortRows: by a declared column, numbers as numbers, text as text ───
const cols = [{ key: 'ticker', format: 'text' }, { key: 'value', format: 'money' }];
const rows = [{ ticker: 'B', value: 10 }, { ticker: 'A', value: 300 }, { ticker: 'C', value: null }, { ticker: 'D', value: 25 }];
assert.deepStrictEqual(AnswerBlocks.sortRows(rows, '-value', cols).map(r => r.ticker), ['A', 'D', 'B', 'C'], 'nulls last on a descending sort');
assert.deepStrictEqual(AnswerBlocks.sortRows(rows, 'value', cols).map(r => r.ticker), ['B', 'D', 'A', 'C'], 'nulls last ascending too');
assert.deepStrictEqual(AnswerBlocks.sortRows(rows, 'ticker', cols).map(r => r.ticker), ['A', 'B', 'C', 'D']);
assert.deepStrictEqual(AnswerBlocks.sortRows(rows, '-nope', cols).map(r => r.ticker), ['B', 'A', 'C', 'D'], 'an unknown column leaves the order alone');
assert.notStrictEqual(AnswerBlocks.sortRows(rows, '', cols), rows, 'always a copy');

// ── normalize: a builder's block is trimmed and capped; nothing to draw → null ──
assert.strictEqual(AnswerBlocks.normalize(null), null);
assert.strictEqual(AnswerBlocks.normalize({ kind: 'stats', items: [] }), null);
assert.strictEqual(AnswerBlocks.normalize({ kind: 'table', columns: [{ key: 'a' }], rows: [] }), null);
assert.strictEqual(AnswerBlocks.normalize({ kind: 'line', points: [{ x: '2026-01-01', y: 1 }] }), null, 'one point is not a line');
assert.strictEqual(AnswerBlocks.normalize({ kind: 'pie', items: [{ label: 'a', value: 1 }] }), null, 'an unknown kind is refused');
const bigTable = AnswerBlocks.normalize({ kind: 'table', columns: [{ key: 'v', format: 'money' }], rows: Array.from({ length: 200 }, (_, i) => ({ v: i })) });
assert.strictEqual(bigTable.rows.length, AnswerBlocks.MAX_ROWS);
const longLine = AnswerBlocks.normalize({ kind: 'line', points: Array.from({ length: 2000 }, (_, i) => ({ x: `d${i}`, y: i })) });
assert.ok(longLine.points.length <= AnswerBlocks.MAX_POINTS + 1);
assert.strictEqual(longLine.points[longLine.points.length - 1].y, 1999, 'thinning keeps the last point');
assert.strictEqual(longLine.signed, true, 'a line is signed unless the builder says otherwise');
const stats = AnswerBlocks.normalize({ kind: 'stats', title: 'T', items: [{ label: 'Net worth', value: 100, format: 'money' }, { label: 'x' }, null] });
assert.strictEqual(stats.items.length, 1, 'items missing a value are dropped');

// ── render: B2 — no view, nothing (or a placeholder while streaming) ───
const views = {
    stats: { kind: 'stats', items: [{ label: 'Net worth', value: 250000, format: 'money' }, { label: 'Today', value: -1200, format: 'money', signed: true, sub: '-0.5%' }] },
    holdings: { kind: 'table', title: 'Top <holdings>', sort: '-value', columns: [
        { key: 'ticker', label: 'Holding', format: 'text' }, { key: 'value', label: 'Value', format: 'money' }, { key: 'gainPct', label: 'Gain %', format: 'pct', signed: true }
    ], rows: [
        { ticker: 'AAPL', value: 1000, gainPct: 12.5, _link: 'anjadhe://ticker/AAPL' },
        { ticker: 'MSFT <b>', value: 5000, gainPct: -2 },
        { ticker: 'NVDA', value: 3000, gainPct: 40 }
    ] },
    allocation: { kind: 'bar', items: [{ label: 'Equities', value: 70, format: 'pct' }, { label: 'Cash', value: 30, format: 'pct' }] },
    value: { kind: 'line', label: 'Net worth', format: 'money', signed: true, points: [{ x: '2026-01-01', y: 100 }, { x: '2026-02-01', y: 90 }, { x: '2026-03-01', y: 120 }] }
};
assert.strictEqual(AnswerBlocks.render('holdings', undefined), '', 'an old message with no views draws nothing');
assert.strictEqual(AnswerBlocks.render('invented', views), '', 'a view the turn did not build draws nothing');
assert.ok(/ab-pending/.test(AnswerBlocks.render('holdings', undefined, { streaming: true })), 'a quiet placeholder mid-stream');
assert.strictEqual(AnswerBlocks.render('', views), '');

// stats
const statsHtml = AnswerBlocks.render('stats', views);
assert.ok(/ab-stats/.test(statsHtml));
assert.ok(/\$250,000/.test(statsHtml));
assert.ok(/ab-stat-value is-down">−\$1,200/.test(statsHtml), 'a signed negative is red and formatted by code');
assert.ok(!/is-down">\$250,000|is-up">\$250,000/.test(statsHtml), 'an unsigned value carries no tone');

// table: sorted by the block's default, escaped, numbers right-aligned, linked first cell
const tableHtml = AnswerBlocks.render('holdings', views);
assert.ok(/Top &lt;holdings&gt;/.test(tableHtml), 'titles are escaped');
assert.ok(/MSFT &lt;b&gt;/.test(tableHtml), 'cell text is escaped');
assert.ok(!/<b>/.test(tableHtml));
const order = [...tableHtml.matchAll(/<tr><td[^>]*>(?:<a [^>]*>)?([^<]+)/g)].map(m => m[1]);
assert.deepStrictEqual(order, ['MSFT &lt;b&gt;', 'NVDA', 'AAPL'], 'rows follow the default sort (-value)');
assert.ok(/th data-sort="value"[^>]*class="is-num is-sorted is-desc"/.test(tableHtml), 'the sorted header says so');
assert.ok(/<td data-v="5000" class="is-num">\$5,000/.test(tableHtml), 'raw value rides data-v for client-side sort; numbers are right-aligned');
assert.ok(/class="is-num is-down">−2%/.test(tableHtml), 'a signed column colours by sign');
assert.ok(/class="is-num is-up">\+40%/.test(tableHtml));
assert.ok(!/<a /.test(tableHtml), 'with no RecordLinks in scope the first cell is plain text, never a dead anchor');

// table: the fence's own sort and limit override the block's
const limited = AnswerBlocks.render('holdings sort=-gainPct limit=2', views);
const order2 = [...limited.matchAll(/<tr><td[^>]*>([^<]+)/g)].map(m => m[1]);
assert.deepStrictEqual(order2, ['NVDA', 'AAPL']);
assert.ok(/1 more not shown/.test(limited));

// table: a record link on the first cell when RecordLinks can parse it
global.RecordLinks = {
    parse: (u) => { const m = String(u).match(/^anjadhe:\/\/(\w+)\/(.+)$/); return m ? { type: m[1], id: m[2] } : null; },
    anchorHtml: (type, id, label) => `<a class="record-link" data-type="${type}" data-id="${id}">${label}</a>`
};
const linked = AnswerBlocks.render('holdings', views);
assert.ok(/<a class="record-link" data-type="ticker" data-id="AAPL">AAPL<\/a>/.test(linked), 'the builder\'s _link becomes the row\'s door');
assert.strictEqual((linked.match(/<a /g) || []).length, 1, 'rows without a link stay plain');
delete global.RecordLinks;

// bar
const barHtml = AnswerBlocks.render('allocation', views);
assert.ok(/ab-bar-fill" style="width:100%"/.test(barHtml), 'the largest bar fills the track');
assert.ok(/style="width:42\.9%"/.test(barHtml), 'the rest scale to it');
assert.ok(/70%<\/div>/.test(barHtml));

// line
const lineHtml = AnswerBlocks.render('value', views);
assert.ok(/<svg class="ab-line-svg is-up"/.test(lineHtml), 'last above first → up');
assert.ok(/<path class="ab-line-path" d="M6\.0,/.test(lineHtml), 'a real path from the first point');
assert.ok(/\+\$20/.test(lineHtml) && /\+20%/.test(lineHtml), 'the change over the range, signed by code');
assert.ok(/\$90 – \$120/.test(lineHtml), 'min – max on the axis');
const down = AnswerBlocks.render('value', { value: { ...views.value, points: [{ x: '2026-01-01', y: 100 }, { x: '2026-02-01', y: 80 }] } });
assert.ok(/ab-line-svg is-down/.test(down));
const flat = AnswerBlocks.render('value', { value: { ...views.value, signed: false } });
assert.ok(/<svg class="ab-line-svg"/.test(flat), 'an unsigned series stays ink');
const g = AnswerBlocks.linePath([{ y: 5 }, { y: 5 }], 100, 50, 0);
assert.ok(Number.isFinite(g.lastY), 'a flat line does not divide by zero');

// a block never carries script or raw HTML from a builder
const nasty = AnswerBlocks.render('x', { x: { kind: 'bar', items: [{ label: '<img src=x onerror=alert(1)>', value: 1, format: 'number' }] } });
assert.ok(!/<img/.test(nasty) && /&lt;img/.test(nasty));

console.log('answer-blocks: ok');
