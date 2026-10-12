/**
 * AnswerBlocks — charts, stat rows and sortable tables inside an assistant
 * answer (2026-10-07).
 *
 * An answer used to be one Markdown string, so every number a person saw
 * was a number the model typed. A block is different: the MODEL decides
 * which view fits the question and where it goes in the reply (that is
 * judgment), and CODE draws it from the tool result the turn actually
 * produced (those are facts). A tool offers its views at registration
 * (`AgentTools.register(def, handler, { views: { id: (result, args) =>
 * block } })`); the turn builds them as the tool runs (`turnViews` in
 * AgentService.sendMessage) and they ride the message's metadata; the
 * model asks for one with a fence:
 *
 *     ```nenva
 *     holdings sort=-value limit=10
 *     ```
 *
 * Laws:
 *   B1  A block shows a tool result from THIS turn, built by that tool's
 *       own code. The model names the view; it never supplies a number.
 *   B2  A view the turn did not build renders NOTHING — an invented name,
 *       an old message, a surface without the kit. Never a fabricated
 *       chart, never a raw code box with the view's name in it.
 *   B3  Code formats every value from a declared format. Colour is state:
 *       a SIGNED series or column takes red/green from its own sign;
 *       everything else is ink and hairlines (DESIGN_SYSTEM).
 *   B4  Interaction is client-side — sort, hover values — never a model
 *       round trip.
 *   B5  The fence degrades to prose: its body is a view name a person can
 *       read, and it holds no data, so a copy of the answer or the phone's
 *       Markdown view loses the picture, never the facts (the model is told
 *       to write the sentence of judgment around the block, not inside it).
 *
 * Block shapes a `views` builder may return (all carry an optional `title`):
 *   { kind:'stats', items:[{ label, value, format, signed?, sub? }] }
 *   { kind:'table', columns:[{ key, label, format, signed?, align? }],
 *                    rows:[{ ...values, _link? }], sort?: '-key' }
 *   { kind:'bar',   items:[{ label, value, format }] }
 *   { kind:'line',  points:[{ x, y }], format, signed?, label? }
 * Formats: money | money2 | pct | number | shares | text | date | clock
 * (minutes after midnight, shown as a time of day).
 *
 * Pure parts (parse, formatValue, sortRows, linePath, render) run in plain
 * Node — tests/answer-blocks-test.js. `install()` is the one DOM piece.
 */
const AnswerBlocks = {
    LANG: 'nenva',
    MAX_ROWS: 60,
    MAX_POINTS: 400,

    /**
     * Lift every ```nenva fence out of (already HTML-escaped) answer text
     * BEFORE the Markdown line scan, leaving one placeholder line per block
     * (PLACEHOLDER_RX). This is what forgives a model the slips it makes
     * with a fence it was told about in prose (nenva cloud lite,
     * 2026-10-07): wrapping the fence in a second bare fence, doubling its
     * closer, or nesting one ```nenva inside another — each of which
     * flipped the scanner's fence parity and poured the rest of the reply
     * into a code box. A bare fence line directly before or after a block
     * is read as that wrapper, never as a code block of its own.
     */
    lift(text) {
        const blocks = [];
        if (!text || text.indexOf('```nenva') === -1) return { text, blocks };
        const put = (body) => `\x00AB${blocks.push(body) - 1}\x00`;
        let out = text
            // One-line form: ```nenva stats```
            .replace(/```nenva[^\S\n]+([^\n`]+?)[^\S\n]*```/g, (m, body) => put(body))
            // Block form; the closer must end its line, so a nested ```nenva
            // line is body (parse() skips the backtick token) not a closer.
            .replace(/```nenva[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```(?=[^\S\n]*(?:\n|$))/g, (m, body) => put(body));
        // The wrapper: a bare fence line right before, and/or right after.
        out = out.replace(/(^|\n)[^\S\n]*```[^\S\n]*\n(?=[^\S\n]*\x00AB\d+\x00)/g, '$1');
        out = out.replace(/(\x00AB\d+\x00)[^\S\n]*\n[^\S\n]*```[^\S\n]*(?=\n|$)/g, '$1');
        return { text: out, blocks };
    },
    PLACEHOLDER_RX: /^\s*\x00AB(\d+)\x00\s*$/,
    /** Put a lifted block back as the fence it was (for text that stays verbatim, e.g. inside a real code block). */
    unlift(line, blocks) {
        return line.replace(/\x00AB(\d+)\x00/g, (m, n) => '```nenva\n' + (blocks[+n] || '') + '\n```');
    },

    /** "holdings sort=-value limit=10" → { id, sort, limit }. Null for nothing usable. */
    parse(text) {
        const tokens = String(text || '').replace(/&quot;|&#39;|"|'/g, '').trim().split(/\s+/).filter(Boolean);
        if (!tokens.length) return null;
        let id = null;
        const spec = {};
        for (const t of tokens) {
            const m = t.match(/^([a-z]+)=(.+)$/i);
            if (m) {
                const k = m[1].toLowerCase();
                if (k === 'sort') spec.sort = m[2].slice(0, 40);
                else if (k === 'limit') { const n = parseInt(m[2], 10); if (n > 0) spec.limit = Math.min(n, this.MAX_ROWS); }
                else if (k === 'view') id = id || m[2];
            } else if (!id && /^[a-z][\w-]*$/i.test(t)) {
                id = t;
            }
        }
        if (!id) return null;
        spec.id = id.toLowerCase();
        return spec;
    },

    esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    /** Code formats; the model never does (B3). */
    formatValue(v, format, signed) {
        if (v == null || v === '') return '';
        if (format === 'text') return String(v);
        if (format === 'date') {
            // A bare day ("2026-04-09") is a LOCAL day, not UTC midnight —
            // read as UTC it shows as the day before west of Greenwich.
            const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
            const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
            if (Number.isNaN(d.getTime())) return String(v);
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
        }
        const n = Number(v);
        if (!Number.isFinite(n)) return String(v);
        // A time of day kept as minutes after midnight (a bedtime, docs/COACH.md).
        if (format === 'clock') { const m = ((Math.round(n) % 1440) + 1440) % 1440, h = Math.floor(m / 60); return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; }
        const sign = signed ? (n > 0 ? '+' : n < 0 ? '−' : '') : (n < 0 ? '−' : '');
        const a = Math.abs(n);
        let body;
        switch (format) {
            case 'money': body = '$' + a.toLocaleString(undefined, { maximumFractionDigits: 0 }); break;
            case 'money2': body = '$' + a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); break;
            case 'pct': body = a.toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%'; break;
            case 'shares': body = a.toLocaleString(undefined, { maximumFractionDigits: 4 }); break;
            default: body = a.toLocaleString(undefined, { maximumFractionDigits: 2 });
        }
        return sign + body;
    },

    /** The tone class for a signed value: state, never theme (B3). */
    tone(v, signed) {
        if (!signed) return '';
        const n = Number(v);
        if (!Number.isFinite(n) || n === 0) return '';
        return n > 0 ? ' is-up' : ' is-down';
    },

    /** '-value' → by value descending; 'ticker' ascending. Stable; strings compare as text. */
    sortRows(rows, sort, columns) {
        if (!sort) return rows.slice();
        const desc = sort[0] === '-';
        const key = desc ? sort.slice(1) : sort;
        const col = (columns || []).find(c => c.key === key);
        if (!col) return rows.slice();
        const textual = col.format === 'text' || col.format === 'date';
        return rows.slice().sort((a, b) => {
            const av = a[key], bv = b[key];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            let c;
            if (textual) c = String(av).localeCompare(String(bv));
            else c = Number(av) - Number(bv);
            return desc ? -c : c;
        });
    },

    /** Trimmed, size-capped copy of a builder's block, or null when it has nothing to draw. */
    normalize(block) {
        if (!block || typeof block !== 'object') return null;
        const out = { kind: block.kind };
        if (block.title) out.title = String(block.title).slice(0, 120);
        if (block.kind === 'stats') {
            out.items = (block.items || []).filter(i => i && i.label != null && i.value != null).slice(0, 8)
                .map(i => ({ label: String(i.label).slice(0, 60), value: i.value, format: i.format || 'number', signed: !!i.signed, sub: i.sub ? String(i.sub).slice(0, 60) : undefined }));
            return out.items.length ? out : null;
        }
        if (block.kind === 'table') {
            out.columns = (block.columns || []).filter(c => c && c.key).slice(0, 10)
                .map(c => ({ key: String(c.key), label: String(c.label || c.key).slice(0, 40), format: c.format || 'text', signed: !!c.signed, align: c.align }));
            out.rows = (block.rows || []).filter(r => r && typeof r === 'object').slice(0, this.MAX_ROWS);
            if (block.sort) out.sort = String(block.sort).slice(0, 40);
            return out.columns.length && out.rows.length ? out : null;
        }
        if (block.kind === 'bar') {
            out.items = (block.items || []).filter(i => i && i.label != null && Number.isFinite(Number(i.value))).slice(0, 20)
                .map(i => ({ label: String(i.label).slice(0, 60), value: Number(i.value), format: i.format || 'number' }));
            return out.items.length ? out : null;
        }
        if (block.kind === 'line') {
            const pts = (block.points || []).filter(p => p && Number.isFinite(Number(p.y)));
            // Thin evenly, never truncate: the last point is the one that matters.
            const step = Math.max(1, Math.ceil(pts.length / this.MAX_POINTS));
            out.points = pts.filter((p, i) => i % step === 0 || i === pts.length - 1).map(p => ({ x: p.x, y: Number(p.y) }));
            out.format = block.format || 'number';
            out.signed = block.signed !== false;
            if (block.label) out.label = String(block.label).slice(0, 60);
            return out.points.length >= 2 ? out : null;
        }
        return null;
    },

    /**
     * Render the fence body against the turn's views. `views` is the
     * message's metadata.views ({ id: block }); absent → nothing (B2), or
     * a quiet placeholder while the reply is still streaming.
     */
    render(specText, views, opts = {}) {
        const spec = this.parse(specText);
        if (!spec) return '';
        const block = views && views[spec.id];
        if (!block) return opts.streaming ? '<div class="ab ab-pending" aria-hidden="true"></div>' : '';
        switch (block.kind) {
            case 'stats': return this.renderStats(block);
            case 'table': return this.renderTable(block, spec);
            case 'bar': return this.renderBar(block);
            case 'line': return this.renderLine(block);
            default: return '';
        }
    },

    _title(block) {
        return block.title ? `<div class="ab-title">${this.esc(block.title)}</div>` : '';
    },

    renderStats(block) {
        const tiles = block.items.map(i => {
            const tone = this.tone(i.value, i.signed);
            return `<div class="ab-stat">`
                + `<div class="ab-stat-label">${this.esc(i.label)}</div>`
                + `<div class="ab-stat-value${tone}">${this.esc(this.formatValue(i.value, i.format, i.signed))}</div>`
                + (i.sub ? `<div class="ab-stat-sub${tone}">${this.esc(i.sub)}</div>` : '')
                + `</div>`;
        }).join('');
        return `<div class="ab ab-stats">${this._title(block)}<div class="ab-stats-grid">${tiles}</div></div>`;
    },

    renderTable(block, spec = {}) {
        const sort = spec.sort || block.sort || '';
        let rows = this.sortRows(block.rows, sort, block.columns);
        if (spec.limit) rows = rows.slice(0, spec.limit);
        const sortKey = sort.replace(/^-/, '');
        const sortDesc = sort[0] === '-';
        const head = block.columns.map(c => {
            const numeric = c.format !== 'text' && c.format !== 'date';
            const active = c.key === sortKey ? ` is-sorted${sortDesc ? ' is-desc' : ''}` : '';
            return `<th data-sort="${this.esc(c.key)}" data-kind="${numeric ? 'num' : 'text'}" class="${numeric ? 'is-num' : ''}${active}" role="button" tabindex="0" aria-sort="${c.key === sortKey ? (sortDesc ? 'descending' : 'ascending') : 'none'}">${this.esc(c.label)}</th>`;
        }).join('');
        const body = rows.map(r => {
            const cells = block.columns.map((c, idx) => {
                const v = r[c.key];
                const numeric = c.format !== 'text' && c.format !== 'date';
                let text = this.esc(this.formatValue(v, c.format, c.signed));
                // The first cell is the row's door when the builder gave one
                // (an anjadhe:// link, validated at click by RecordLinks).
                if (idx === 0 && r._link && typeof RecordLinks !== 'undefined' && RecordLinks.parse) {
                    const rec = RecordLinks.parse(String(r._link));
                    if (rec) text = RecordLinks.anchorHtml(rec.type, rec.id, text);
                }
                const raw = numeric && v != null && Number.isFinite(Number(v)) ? Number(v) : (v == null ? '' : String(v));
                return `<td data-v="${this.esc(raw)}" class="${numeric ? 'is-num' : ''}${this.tone(v, c.signed)}">${text}</td>`;
            }).join('');
            return `<tr>${cells}</tr>`;
        }).join('');
        const more = block.rows.length > rows.length ? `<div class="ab-more">${block.rows.length - rows.length} more not shown</div>` : '';
        return `<div class="ab ab-table">${this._title(block)}<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}</div>`;
    },

    renderBar(block) {
        const max = Math.max(...block.items.map(i => Math.abs(i.value)), 0) || 1;
        const rows = block.items.map(i => {
            const w = Math.round((Math.abs(i.value) / max) * 1000) / 10;
            return `<div class="ab-bar-row">`
                + `<div class="ab-bar-label">${this.esc(i.label)}</div>`
                + `<div class="ab-bar-track"><div class="ab-bar-fill" style="width:${w}%"></div></div>`
                + `<div class="ab-bar-value">${this.esc(this.formatValue(i.value, i.format))}</div>`
                + `</div>`;
        }).join('');
        return `<div class="ab ab-bar">${this._title(block)}${rows}</div>`;
    },

    /** Pure geometry for a line: the SVG path, plus where the ends sit. */
    linePath(points, width, height, pad) {
        const ys = points.map(p => p.y);
        let min = Math.min(...ys), max = Math.max(...ys);
        if (max === min) { max += 1; min -= 1; }
        const n = points.length;
        const x = i => pad + (i / (n - 1)) * (width - pad * 2);
        const y = v => pad + (1 - (v - min) / (max - min)) * (height - pad * 2);
        const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
        const area = `${d} L${x(n - 1).toFixed(1)},${(height - pad).toFixed(1)} L${x(0).toFixed(1)},${(height - pad).toFixed(1)} Z`;
        return { d, area, min, max, lastX: x(n - 1), lastY: y(points[n - 1].y) };
    },

    renderLine(block) {
        const W = 600, H = 160, PAD = 6;
        const pts = block.points;
        const g = this.linePath(pts, W, H, PAD);
        const first = pts[0].y, last = pts[pts.length - 1].y;
        const tone = block.signed ? (last > first ? ' is-up' : last < first ? ' is-down' : '') : '';
        const change = last - first;
        const changePct = first ? (change / Math.abs(first)) * 100 : null;
        const fmt = v => this.esc(this.formatValue(v, block.format));
        const dateOf = v => this.esc(this.formatValue(v, 'date'));
        const head = `<div class="ab-line-head">`
            + `<div class="ab-line-label">${this.esc(block.label || '')}</div>`
            + `<div class="ab-line-now${tone}">${fmt(last)}`
            + (block.signed ? `<span class="ab-line-change">${this.esc(this.formatValue(change, block.format, true))}${changePct != null ? ` (${this.esc(this.formatValue(changePct, 'pct', true))})` : ''}</span>` : '')
            + `</div></div>`;
        const svg = `<svg class="ab-line-svg${tone}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`
            + `<path class="ab-line-area" d="${g.area}"></path>`
            + `<path class="ab-line-path" d="${g.d}"></path>`
            + `<circle class="ab-line-dot" cx="${g.lastX.toFixed(1)}" cy="${g.lastY.toFixed(1)}" r="3"></circle>`
            + `</svg>`;
        const axis = `<div class="ab-line-axis"><span>${dateOf(pts[0].x)}</span><span class="ab-line-range">${fmt(g.min)} – ${fmt(g.max)}</span><span>${dateOf(pts[pts.length - 1].x)}</span></div>`;
        return `<div class="ab ab-line">${this._title(block)}${head}${svg}${axis}</div>`;
    },

    /** One delegated handler for the whole document: header click re-sorts a table (B4). */
    install() {
        if (this._installed || typeof document === 'undefined') return;
        this._installed = true;
        const sortBy = (th) => {
            const table = th.closest('table');
            if (!table) return;
            const idx = Array.from(th.parentNode.children).indexOf(th);
            const wasDesc = th.classList.contains('is-sorted') && th.classList.contains('is-desc');
            const wasSorted = th.classList.contains('is-sorted');
            // First click on a numeric column: biggest first; on text: A→Z.
            const desc = wasSorted ? !wasDesc : th.dataset.kind === 'num';
            const numeric = th.dataset.kind === 'num';
            const tbody = table.tBodies[0];
            const rows = Array.from(tbody.rows);
            rows.sort((a, b) => {
                const av = a.cells[idx]?.dataset.v ?? '', bv = b.cells[idx]?.dataset.v ?? '';
                if (av === '' && bv === '') return 0;
                if (av === '') return 1;
                if (bv === '') return -1;
                const c = numeric ? Number(av) - Number(bv) : String(av).localeCompare(String(bv));
                return desc ? -c : c;
            });
            for (const r of rows) tbody.appendChild(r);
            for (const h of th.parentNode.children) { h.classList.remove('is-sorted', 'is-desc'); h.setAttribute('aria-sort', 'none'); }
            th.classList.add('is-sorted');
            if (desc) th.classList.add('is-desc');
            th.setAttribute('aria-sort', desc ? 'descending' : 'ascending');
        };
        document.addEventListener('click', (e) => {
            const th = e.target.closest?.('.ab-table th[data-sort]');
            if (th) sortBy(th);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const th = e.target.closest?.('.ab-table th[data-sort]');
            if (th) { e.preventDefault(); sortBy(th); }
        });
    }
};

if (typeof module !== 'undefined') module.exports = AnswerBlocks;
