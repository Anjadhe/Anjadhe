/**
 * DocTidy — making extracted document text READABLE (2026-09-02).
 *
 * What the index holds is what the extractors produce: pdf.js emits one
 * line per visual line with `[Page N]` markers, OCR emits whatever Vision
 * saw, spreadsheets come out as rows. Fine for search, unreadable as a
 * page. Two layers fix the reader, both DISPLAY ONLY — the index and the
 * assistant's read_library_doc keep the raw extraction (facts, not a
 * rewrite; the original file is one click away):
 *
 *  1. `reflow(text)` — free and instant, pure arithmetic: joins the hard
 *     line breaks inside a paragraph, de-hyphenates words split at a line
 *     end, keeps headings/lists/tabular lines on their own lines, turns
 *     page markers into quiet rules. Always applied to the extracted view.
 *  2. `run(...)` — the AI tidy the user asked for ("rewrite the document
 *     once so it can be shown neatly"): the user's chosen brain rewrites
 *     the extracted text as clean Markdown, streamed, in paragraph-bounded
 *     segments so a long document fits any context window, CACHED per
 *     document + file mtime in the machine-local index DB (one rewrite,
 *     ever, until the file changes). Runs automatically on first open when
 *     the brain is on this Mac, or off it with the Files cloud-privacy
 *     class allowed (CloudPrivacy.allows('files') — the same gate ambient
 *     file reads use); otherwise the reader offers a "Tidy with AI" button
 *     that names where the text would go, and a click is the consent.
 *     The prompt forbids summarizing, adding or dropping content; the
 *     result is still a model's rewrite, which is why the extracted text
 *     stays one toggle away and the banner says so.
 *  3. `runVision(...)` — "Read with vision" (same day; Ram: pdf.js's text
 *     is not very accurate, a vision-capable model is much more accurate):
 *     when the brain can SEE (AgentService.supportsVision — a local model
 *     with its mmproj adapter, a vision cloud model, a custom server), a
 *     PDF or image is read from its RENDERED PAGES (`library-page` IPC,
 *     PDFKit at 1400px) instead of its text layer, one page per call,
 *     transcribed to Markdown. It is saved with method 'vision' and
 *     BECOMES the document's text — main rebuilds the index from it and
 *     read_library_doc serves it — because it is better than any parser
 *     at every use. Automatic up to PAGE_CAP pages under the same privacy
 *     gate as the tidy; the rest of a long document is one click.
 */
const DocTidy = {
    SEGMENT_CHARS: 7000,
    SOURCE: 'doc-tidy',
    VISION_SOURCE: 'doc-vision',
    // Pages read automatically on open; beyond it the reader offers the rest.
    PAGE_CAP: 25,
    PAGE_MAX_EDGE: 1400,

    // ── Reflow (pure) ──────────────────────────────────────────────────

    _median(nums) {
        if (!nums.length) return 0;
        const s = [...nums].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
    },

    _tabular(line) {
        return /\t/.test(line) || (line.match(/ {2,}/g) || []).length >= 2 || /\|.*\|/.test(line);
    },

    /** A line that stands alone: headings (markdown or a short ALL-CAPS
     *  title), rules, bare page numbers. */
    _standalone(t) {
        return /^#{1,6}\s/.test(t)
            || (t.length <= 70 && /[A-Z]{3}/.test(t) && t === t.toUpperCase() && !/[.:]$/.test(t))
            || /^(page \d+( of \d+)?|-{3,}|={3,})$/i.test(t);
    },

    /** A list item or numbered clause STARTS a paragraph (its wrapped
     *  continuation lines still join it). */
    _startsItem(t) {
        return /^([-*•▪◦]|\d{1,3}[.)]|\(\d{1,3}\)|[a-z][.)])\s/.test(t);
    },

    /**
     * Blocks for display: [{kind:'para'|'line'|'table'|'page', text}].
     * A paragraph ends at a blank line, before a standalone line, or at a
     * SHORT line ending in sentence punctuation (the last line of a
     * paragraph in a PDF is usually short — measured against the median
     * line length, so a document set in short lines still reflows).
     */
    blocks(text) {
        const lines = String(text || '').replace(/\r/g, '').split('\n');
        const lens = lines.map(l => l.trim().length).filter(n => n > 0);
        const median = this._median(lens) || 80;
        const shortEnd = Math.max(30, median * 0.6);
        const out = [];
        let para = [];
        let table = [];
        const flushPara = () => { if (para.length) { out.push({ kind: 'para', text: para.join(' ') }); para = []; } };
        const flushTable = () => { if (table.length) { out.push({ kind: 'table', text: table.join('\n') }); table = []; } };
        for (const raw of lines) {
            const t = raw.trim();
            if (!t) { flushPara(); flushTable(); continue; }
            if (/^\[Page \d+\]$/.test(t)) { flushPara(); flushTable(); out.push({ kind: 'page', text: t.slice(1, -1) }); continue; }
            if (this._tabular(raw)) { flushPara(); table.push(raw.replace(/\s+$/, '')); continue; }
            flushTable();
            if (this._standalone(t)) { flushPara(); out.push({ kind: 'line', text: t }); continue; }
            if (this._startsItem(t)) flushPara();
            if (para.length) {
                const prev = para[para.length - 1];
                if (/\w-$/.test(prev) && /^[a-z]/.test(t)) para[para.length - 1] = prev.slice(0, -1) + t;
                else para.push(t);
            } else {
                para.push(t);
            }
            if (t.length < shortEnd && /[.!?:;"”)]$/.test(t)) flushPara();
        }
        flushPara(); flushTable();
        return out;
    },

    /** Plain reflowed text (blocks joined by blank lines). */
    reflow(text) {
        return this.blocks(text).map(b => b.kind === 'page' ? `— ${b.text} —` : b.text).join('\n\n');
    },

    /** Reflowed blocks as HTML; `mark` wraps query terms (escaped input). */
    reflowHtml(text, mark = (s) => s) {
        const esc = (s) => UIUtils.escapeHtml(String(s || ''));
        return this.blocks(text).map(b => {
            if (b.kind === 'page') return `<p class="library-page-mark">${esc(b.text)}</p>`;
            if (b.kind === 'table') return `<pre class="library-reader-table">${mark(esc(b.text))}</pre>`;
            return `<p>${mark(esc(b.text))}</p>`;
        }).join('');
    },

    // ── Segments + guards (pure) ───────────────────────────────────────

    /** Cut text at paragraph (then line) boundaries into ≤ max-char pieces. */
    segments(text, max = this.SEGMENT_CHARS) {
        const src = String(text || '');
        if (src.length <= max) return src.trim() ? [src] : [];
        const out = [];
        let rest = src;
        while (rest.length > max) {
            let cut = rest.lastIndexOf('\n\n', max);
            if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
            if (cut < max * 0.5) cut = rest.lastIndexOf('. ', max) + 1;
            if (cut < max * 0.5) cut = max;
            out.push(rest.slice(0, cut));
            rest = rest.slice(cut).replace(/^\s+/, '');
        }
        if (rest.trim()) out.push(rest);
        return out;
    },

    /** Drop consecutive duplicate paragraphs (small models can loop). */
    dedupe(text) {
        const paras = String(text || '').split(/\n{2,}/);
        const out = [];
        for (const p of paras) {
            const t = p.trim();
            if (t && out.length && out[out.length - 1].trim() === t) continue;
            out.push(p);
        }
        return out.join('\n\n');
    },

    // ── Policy ─────────────────────────────────────────────────────────

    available() {
        return typeof AgentService !== 'undefined' && !!AgentService.model
            && typeof LLMLogger !== 'undefined' && typeof LLMLogger.callStream === 'function';
    },

    /** May the tidy start on its own when a document opens? */
    autoAllowed() {
        if (!this.available()) return false;
        if (typeof CloudPrivacy === 'undefined') return true;
        return !CloudPrivacy.brainLeaves() || CloudPrivacy.allows('files');
    },

    /** Is this a document a vision model reads from its pages? */
    isPaged(relpath) {
        return /\.(pdf|png|jpe?g|heic|heif|tiff?|gif|webp|bmp)$/i.test(String(relpath || ''));
    },

    /** Can the current brain see? (async: the capability inputs load once) */
    async visionAvailable() {
        if (typeof AgentService === 'undefined' || !AgentService.supportsVision) return false;
        try { await AgentService.ensureVisionInfo(); } catch { /* offline — cached inputs */ }
        try { return !!AgentService.supportsVision(AgentService.getDefaultEntry?.() || null); } catch { return false; }
    },

    destination() {
        try { return (typeof CloudPrivacy !== 'undefined' && CloudPrivacy.brainLeaves()) ? (CloudPrivacy.brainDestination() || 'your AI model') : null; }
        catch { return null; }
    },

    // ── The run ────────────────────────────────────────────────────────

    _prompt() {
        return [
            'You rewrite text that was mechanically extracted from a document (a PDF, a scan, a spreadsheet, a web page) into clean, readable Markdown.',
            'Fix what extraction broke: rejoin lines that belong to one paragraph, merge words hyphen-ated across lines, restore headings (## …), bullet and numbered lists, and lay tables out as Markdown tables. Keep the order of the content.',
            'Keep EVERY fact exactly as written — numbers, amounts, dates, names, addresses, identifiers, quotes. Do not summarize, shorten, paraphrase, add, explain, or drop anything. If a passage is unreadable, keep it as it is.',
            'Replace a "[Page N]" marker with a line containing only "---". Drop repeated running headers and footers and page numbers that appear on every page.',
            'No commentary before or after. No code fences around the whole output. Output only the Markdown.',
            'Never repeat a sentence or paragraph you have already written; when the text ends, stop.'
        ].join('\n');
    },

    /**
     * Tidy `rawText`, segment by segment. `onPartial(textSoFar, {part,
     * parts})` streams progress; `token.cancelled` aborts between chunks.
     * Resolves {text} or {error}. Manual runs pass `manual: true` (the
     * click is the consent; the source tag stays for the ledger).
     */
    async run(rawText, { onPartial, token = {}, manual = false } = {}) {
        if (!this.available()) return { error: 'No AI model is set up (Settings › AI Assistant).' };
        const parts = this.segments(rawText);
        if (!parts.length) return { error: 'Nothing to tidy.' };
        if (!manual && !this.autoAllowed()) return { error: 'Auto-tidy is off for files that leave this Mac.' };
        let accumulated = '';
        for (let i = 0; i < parts.length; i++) {
            if (token.cancelled) return { error: 'cancelled' };
            const params = {
                model: AgentService.model,
                messages: [
                    { role: 'system', content: this._prompt() },
                    { role: 'user', content: (parts.length > 1 ? `[Part ${i + 1} of ${parts.length} of the document.]\n\n` : '') + parts[i] }
                ],
                keep_alive: AgentService.keepAlive,
                think: false,
                options: { temperature: 0.2, repeat_penalty: 1.15, repeat_last_n: 256, num_predict: 6144,
                           num_ctx: Math.max(AgentService.numCtx || 0, Math.ceil(parts[i].length / 3) + 7000, 8192) },
                logTag: this.SOURCE,
                logDetail: `part ${i + 1}/${parts.length}`
            };
            let piece = '';
            const onChunk = (chunk, event) => {
                if (event || typeof chunk !== 'string') return;
                piece += chunk;
                if (onPartial) onPartial(accumulated + (accumulated ? '\n\n' : '') + piece, { part: i + 1, parts: parts.length });
            };
            let response;
            try { response = await LLMLogger.callStream(this.SOURCE, params, onChunk); }
            catch (e) { return { error: e.message || String(e) }; }
            if (response && response.error) return { error: String(response.error).slice(0, 300) };
            const clean = this.dedupe(piece.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```\s*$/, '').trim());
            if (!clean) return { error: 'The model returned no text.' };
            accumulated += (accumulated ? '\n\n' : '') + clean;
        }
        return { text: this.dedupe(accumulated) };
    }
,

    _visionPrompt() {
        return [
            'You transcribe one page of a document from its image into clean Markdown, exactly as printed.',
            'Keep every word, number, amount, date, name, address and identifier exactly. Keep the reading order. Use ## for headings, "-" for bullet lists, numbered lists as printed, and Markdown tables for tabular content (every row, every cell).',
            'For a figure, chart, logo, signature or photo, write one short line in square brackets describing it, e.g. [Chart: monthly balance, rising]. For handwriting, transcribe what is legible and mark unclear words as [illegible].',
            'Do not summarize, add, explain, translate, or drop anything. Do not describe the page layout. No commentary before or after. Output only the Markdown of this page.'
        ].join('\n');
    },

    /**
     * Read a document from its pages. `pages` = total (from the first
     * render); `fromPage` (0-based) continues a partial read. onPartial(
     * textSoFar, {page, pages}) streams; resolves {text, pages, pagesDone}
     * or {error}. `cap` pages are read per run.
     */
    async runVision(docId, { fromPage = 0, cap = this.PAGE_CAP, onPartial, token = {}, manual = false } = {}) {
        if (!this.available()) return { error: 'No AI model is set up (Settings › AI Assistant).' };
        if (!(await this.visionAvailable())) return { error: 'The current AI model cannot see images.' };
        if (!manual && !this.autoAllowed()) return { error: 'Auto-read is off for files that leave this Mac.' };
        if (!window.electronLibrary?.renderPage) return { error: 'Page rendering is not available.' };
        let accumulated = '';
        let pages = 0;
        let page = fromPage;
        const last = fromPage + cap;
        for (; page < last; page++) {
            if (token.cancelled) return { error: 'cancelled' };
            let img;
            try { img = await window.electronLibrary.renderPage(docId, page, this.PAGE_MAX_EDGE); } catch (e) { img = { error: e.message }; }
            if (img.error) {
                if (/no such page/.test(img.error) && page > fromPage) break;
                return { error: img.error };
            }
            pages = img.pages || pages || 1;
            const params = {
                model: AgentService.model,
                messages: [
                    { role: 'system', content: this._visionPrompt() },
                    { role: 'user', content: [
                        { type: 'text', text: `Page ${page + 1} of ${pages}. Transcribe it.` },
                        { type: 'image_url', image_url: { url: img.dataUrl } }
                    ] }
                ],
                keep_alive: AgentService.keepAlive,
                think: false,
                options: { temperature: 0.1, repeat_penalty: 1.15, repeat_last_n: 256, num_predict: 4096,
                           num_ctx: Math.max(AgentService.numCtx || 0, 8192) },
                logTag: this.VISION_SOURCE,
                logDetail: `page ${page + 1}/${pages}`
            };
            let piece = '';
            const head = accumulated ? accumulated + '\n\n---\n\n' : '';
            const onChunk = (chunk, event) => {
                if (event || typeof chunk !== 'string') return;
                piece += chunk;
                if (onPartial) onPartial(head + piece, { page: page + 1, pages });
            };
            let response;
            try { response = await LLMLogger.callStream(this.VISION_SOURCE, params, onChunk); }
            catch (e) { return { error: e.message || String(e) }; }
            if (response && response.error) return { error: String(response.error).slice(0, 300) };
            const clean = this.dedupe(piece.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```\s*$/, '').trim());
            accumulated = head + (clean || '[Page could not be read]');
            if (page + 1 >= pages) { page++; break; }
        }
        return { text: accumulated, pages, pagesDone: Math.min(page, pages) };
    }
};
