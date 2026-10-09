/**
 * PortfolioReader — the article reader for the headlines Finance shows
 * (2026-10-06, by request: "even though we removed the news page, can we
 * still show the new article feature for the news articles we show in
 * finance pages").
 *
 * It is the News app's reader (removed with that app 2026-10-05, commit
 * c2a6e445), carried into the Finance package and reduced to what a
 * headline on a money page needs:
 *
 *  - the article is read ON THIS MAC (`read-url`), and the user's model
 *    writes a SHORT summary from that text alone; when the page will not
 *    load, from search coverage of the headline instead. Every summary
 *    says which.
 *  - A POINTER, NOT A SUBSTITUTE (2026-10-08, after the CNBC legal
 *    review): the summary is two or three sentences in the model's own
 *    words, never the story retold, and "Read the full article on
 *    <publisher>" sits directly under it. The publisher's own text is never
 *    shown (the no-model "extract" mode went); with no model the page is
 *    the headline and that link.
 *  - related coverage: a web search on the headline, from which the model
 *    picks by INDEX (it never writes a title or a link).
 *  - the source block, built from the page's own metadata, never the
 *    model's; the read link goes to the Mac's browser.
 *  - "Ask about it" opens a chat grounded in the article text.
 *
 * Left behind with the News page: saved stories, the date extraction to
 * Schedule, Hacker News threads and the taste ledger.
 *
 * Gates: the article is public web content, read on a click, so the
 * summary is not an ambient call and carries no CloudPrivacy class (as in
 * News). Related coverage and the coverage fallback need web access on,
 * the same consent PortfolioNews rides. Source tags start `portfolio-`
 * so the Portfolio model surface routes them.
 *
 * Summaries are cached under the News reader's own key (`news-summaries`),
 * so what a person already read there opens at once here.
 */
const PortfolioReader = {
    SUMMARY_KEY: 'news-summaries',
    SUMMARY_MAX: 60,           // cached summaries kept (oldest trimmed)
    MIN_ARTICLE_CHARS: 400,    // under this, read_url got a stub, not an article
    ARTICLE_PROMPT_CHARS: 12000,
    // Cached summaries came from this prompt. Bump when the prompt changes.
    // 3 (2026-10-08): short and crisp; drops version 2's long retellings
    // and cached "extract" entries.
    SUMMARY_VERSION: 3,
    RELATED_MAX: 4,            // links shown under a summary
    RELATED_CANDIDATES: 8,     // search results offered to the model to pick from
    RELATED_KINDS: { coverage: 'Same story', background: 'Background', followup: 'What followed' },
    // Aggregators and link farms: a search on a headline returns them, and
    // they are never the second outlet a reader wants.
    RELATED_SKIP_HOSTS: ['news.google.com', 'msn.com', 'news.yahoo.com', 'flipboard.com', 'newsbreak.com',
        'ground.news', 'reddit.com', 'twitter.com', 'x.com', 'facebook.com', 'youtube.com'],

    _current: null,            // {title, url, source, publishedAt, topic}
    _state: null,              // {status} while working, {summary, mode, openUrl, source, related} when done
    _returnTo: null,           // {label, onBack}
    _articleText: '',          // in memory only, for "Ask about it"
    _streamId: null,

    /**
     * Open an article.
     * @param {{title, url, source?, publishedAt?, topic?}} item
     * @param {{returnTo?: {label: string, onBack: Function}}} [opts]
     */
    openReader(item, opts = {}) {
        if (!item || !this._httpUrl(item.url)) return;
        this._abortStream();
        this._returnTo = opts.returnTo || null;
        this._current = item;
        this._articleText = '';
        this._state = { status: 'Reading the article on your Mac…' };
        if (typeof AppManager !== 'undefined' && AppManager.currentApp !== 'portfolio') AppManager.openApp('portfolio');
        document.querySelectorAll('.view.active').forEach(v => v.classList.remove('active'));
        document.getElementById('portfolio-reader-view')?.classList.add('active');
        document.scrollingElement && (document.scrollingElement.scrollTop = 0);
        this.render();
        this._loadSummary(item);
    },

    /** Back to where the reader was opened from (the way in names it). */
    back() {
        this._abortStream();
        const to = this._returnTo;
        this._current = null;
        document.getElementById('portfolio-reader-view')?.classList.remove('active');
        if (to?.onBack) to.onBack();
        else { AppManager.openApp('portfolio'); PortfolioApp.setScope('all'); }
    },

    isOpen() {
        return !!this._current && !!document.getElementById('portfolio-reader-view')?.classList.contains('active');
    },

    /* ---------- the page ---------- */

    render() {
        const el = document.getElementById('portfolio-reader-content');
        const it = this._current;
        if (!el || !it) return;
        const esc = AppManager.escapeHtml;
        const backLabel = this._returnTo?.label || 'Finance';
        Breadcrumb.render('portfolio-reader-breadcrumb', [
            { label: 'Finance', action: () => { this._returnTo = null; this.back(); } },
            ...(backLabel !== 'Finance' ? [{ label: backLabel, action: () => this.back() }] : [])
        ]);

        const st = this._state || {};
        const publisher = st.source?.site || it.source || this._hostOf(it.url);
        const when = this._stamp(st.source?.publishedAt || it.publishedAt);
        const lede = [publisher, when].filter(Boolean).map(esc).join('<span class="pf-sep">·</span>');

        // What the prose below was built from — said every time.
        const note = {
            article: 'AI summary of the article',
            coverage: 'AI summary from other coverage; the article itself would not load'
        }[st.mode] || '';
        // The way to the story, directly under whatever the summary says.
        const actions = `
                <div class="pf-reader-actions">
                    <button type="button" class="primary-btn" data-reader="open">Read the full article on ${esc(publisher || 'the web')}</button>
                    <button type="button" class="pf-link" data-reader="ask">Ask about it</button>
                </div>`;
        let body;
        if (st.summary) {
            const html = (typeof AgentUI !== 'undefined' && AgentUI.formatContent) ? AgentUI.formatContent(st.summary) : this._paragraphs(st.summary);
            body = `
                ${note ? `<p class="pf-reader-note">${esc(note)}</p>` : ''}
                <div class="pf-reader-body">${html}</div>
                ${actions}
                ${st.streaming ? '' : this._relatedHtml(st.related, st.relatedLoading) + this._sourceHtml(st.source)}`;
        } else if (st.error) {
            body = `<p class="pf-empty">${esc(st.error)}</p>${actions}${this._sourceHtml(st.source)}`;
        } else {
            body = `<p class="pf-reader-working">${esc(st.status || 'Working…')}</p>${actions}`;
        }

        el.innerHTML = `
            <article class="pf-reader">
                ${lede ? `<p class="pf-lede">${lede}</p>` : ''}
                <h1 class="pf-reader-title">${esc(it.title || it.url || '')}</h1>
                ${body}
            </article>`;

        el.querySelector('[data-reader="open"]')?.addEventListener('click', () => this._openArticle());
        el.querySelector('[data-reader="ask"]')?.addEventListener('click', () => this._ask());
        el.querySelectorAll('[data-related]').forEach(btn =>
            btn.addEventListener('click', () => this._openRelated(Number(btn.dataset.related))));
        el.querySelectorAll('[data-related-ext]').forEach(btn =>
            btn.addEventListener('click', (e) => { e.stopPropagation(); this._openUrl(this._state?.related?.[Number(btn.dataset.relatedExt)]?.url); }));
        el.querySelector('[data-reader="source"]')?.addEventListener('click', () => this._openArticle());
    },

    // Plain text -> <p> blocks: read_url gives one newline per block; short
    // fragments (nav crumbs) merge into the next paragraph.
    _paragraphs(text) {
        const out = [];
        let pending = '';
        for (const raw of String(text || '').split(/\n+/)) {
            const line = raw.trim();
            if (!line) continue;
            if (line.length < 60) { pending += (pending ? ' ' : '') + line; continue; }
            out.push(pending ? pending + ' ' + line : line);
            pending = '';
        }
        if (pending) out.push(pending);
        return out.map(p => `<p>${AppManager.escapeHtml(p)}</p>`).join('');
    },

    _alive(item) { return this._current === item; },
    _set(item, state) { if (this._alive(item)) { this._state = state; this.render(); } },
    _patch(item, fields) { if (this._alive(item)) { Object.assign(this._state || (this._state = {}), fields); this.render(); } },

    /* ---------- the summary ---------- */

    _readUrl(url) {
        if (!window.electronSearch?.read) return Promise.resolve({ error: 'unavailable' });
        return window.electronSearch.read(url);
    },
    _searchWeb(query) {
        if (window.electronSearch?.query) return window.electronSearch.query(query, 5);
        return Promise.resolve({ error: 'unavailable' });
    },
    async _webOn() {
        return typeof PortfolioNews !== 'undefined' ? PortfolioNews._webOn() : false;
    },
    _modelLabel() {
        try { return AgentService.displayModelName?.(AgentService.getDefaultEntry?.()) || 'your AI model'; }
        catch { return 'your AI model'; }
    },
    _hasModel() {
        return typeof AgentService !== 'undefined' && !!AgentService.model
            && typeof LLMLogger !== 'undefined' && !!window.electronLLM?.chat;
    },

    async _loadSummary(item) {
        const key = this._hash(item.url || item.title);
        const cached = this._summaries()[key];
        if (cached && cached.summary && cached.v === this.SUMMARY_VERSION) {
            this._set(item, {
                summary: cached.summary, mode: cached.mode, openUrl: cached.openUrl, source: cached.source,
                related: Array.isArray(cached.related) ? this._validRelated(cached.related) : undefined
            });
            // Cached before related coverage was looked for: one search now.
            if (!Array.isArray(cached.related)) this._loadRelated(item, key);
            return;
        }

        // 1. The article, on this Mac. read-url trades a Google News shell
        // for the publisher's URL, which becomes the Open link.
        const r = await this._readUrl(String(item.url || ''));
        if (!this._alive(item)) return;
        const articleText = (!r?.error && typeof r?.text === 'string') ? r.text.trim() : '';
        const openUrl = (r && typeof r.url === 'string' && /^https?:/i.test(r.url)) ? r.url : '';
        this._articleText = articleText.slice(0, this.ARTICLE_PROMPT_CHARS);
        // Page metadata wins over the feed's: it knows an update from the
        // original publication.
        const source = {
            url: openUrl || String(item.url || ''),
            title: item.title || r?.title || '',
            site: r?.siteName || item.source || this._hostOf(openUrl || item.url),
            publishedAt: r?.publishedAt || item.publishedAt || null,
            updatedAt: r?.updatedAt || null
        };
        const hasModel = this._hasModel();

        // 2. A model and real text: the summary.
        if (hasModel && articleText.length >= this.MIN_ARTICLE_CHARS) {
            this._set(item, { status: `Writing a summary with ${this._modelLabel()}…`, openUrl, source });
            const summary = await this._summarize(item, item.title,
                `ARTICLE TEXT:\n${articleText.slice(0, this.ARTICLE_PROMPT_CHARS)}`, 'article', openUrl);
            if (!this._alive(item)) return;
            if (summary) {
                this._finish(item, key, { summary, mode: 'article', openUrl, source });
                this._loadRelated(item, key);
                return;
            }
        }

        // 3. Unreadable (or judged a stub): what the coverage says.
        if (hasModel && String(item.title || '').trim() && await this._webOn()) {
            this._set(item, { status: 'The article would not load. Checking other coverage…', openUrl, source });
            try {
                const resp = await this._searchWeb(item.title);
                const results = Array.isArray(resp?.results) ? resp.results : [];
                if (!this._alive(item)) return;
                if (results.length) {
                    const digest = results.map(x =>
                        `- ${x.title || ''}${x.age ? ` (${x.age})` : ''}: ${String(x.snippet || '').slice(0, 250)}`).join('\n');
                    const summary = await this._summarize(item, item.title,
                        `SEARCH COVERAGE (snippets from several sources — the article itself could not be read):\n${digest}`, 'coverage', openUrl);
                    if (!this._alive(item)) return;
                    if (summary) {
                        this._finish(item, key, { summary, mode: 'coverage', openUrl, source });
                        // The coverage search already ran: its results ARE the related links.
                        this._loadRelated(item, key, results);
                        return;
                    }
                }
            } catch { /* the honest endings below */ }
        }

        // 4. No summary: say so, and leave the link. The article's own text
        // is never shown in its place.
        this._set(item, {
            error: hasModel ? 'No summary of this one. The full article is a click away.'
                : 'Add an AI model in Settings for a short summary here.',
            openUrl, source
        });
    },

    // One capped call; streams into the page. Grounded strictly in the
    // material; the source line is the app's, never the model's.
    async _summarize(item, title, material, mode, openUrl) {
        const streamId = `portfolio-article-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this._streamId = streamId;
        try {
            const params = {
                model: AgentService.model,
                messages: [
                    { role: 'system', content: 'You write very short news summaries that point a reader to the full story. You write only from the source material you are given. You never invent facts, numbers, names, dates, or quotes that are not in that material.' },
                    { role: 'user', content: `Headline: ${title}

${material}

Summarize this story in two or three short sentences, under 70 words in all: what happened, and why it matters to an investor. Plain language, your own words, facts only.

Rules: one plain paragraph. No headings, no bullets, no preamble, do not repeat the headline. Do not quote the article and do not retell it; the reader opens the article for the details. Use ONLY the material above; if something is not in it, do not write it. Do not write a source, link, or date line - the app adds that itself.

If the material is not actually article content (a cookie or consent notice, a redirect stub, a paywall or sign-in wall, an error page, unrelated boilerplate), reply with exactly: UNUSABLE` }
                ],
                think: false,
                maxTokens: 300,
                options: { temperature: 0.3, num_ctx: AgentService.numCtx || 8192 },
                stream: true,
                streamId,
                jobClass: 'background',
                logTag: 'portfolio-article'
            };
            // The article page streams (by request, 2026-10-06: "in the
            // article summary page, its ok to stream"), unlike the Finance
            // sections, which unfold whole.
            let acc = '';
            const res = await LLMLogger.callStream('portfolio-article', params, (chunk, kind) => {
                if (kind || typeof chunk !== 'string') return;
                acc += chunk;
                // Hold while the text could still be the UNUSABLE sentinel.
                const head = acc.trimStart();
                if (!head || 'UNUSABLE'.startsWith(head.slice(0, 8).toUpperCase())) return;
                this._paintStream(item, acc, mode, openUrl);
            });
            if (res?.error) return null;
            const text = String(res?.message?.content || '').trim();
            if (!text || /^UNUSABLE\b/i.test(text)) return null;
            return text;
        } catch { return null; }
        finally { if (this._streamId === streamId) this._streamId = null; }
    },

    _abortStream() {
        const id = this._streamId;
        this._streamId = null;
        if (!id) return;
        try { window.electronLLM?.abortStream?.(id); } catch { /* best-effort */ }
    },

    // First chunk swaps the status for the prose; later chunks patch only
    // the prose, so the page keeps its scroll. Related coverage and the
    // source wait for the finished summary.
    _paintStream(item, partial, mode, openUrl) {
        if (!this._alive(item)) return;
        const prev = this._state || {};
        const first = !prev.streaming;
        this._state = { ...prev, summary: partial, mode, openUrl, streaming: true, status: undefined };
        const body = document.querySelector('#portfolio-reader-content .pf-reader-body');
        if (first || !body) { this.render(); return; }
        body.innerHTML = (typeof AgentUI !== 'undefined' && AgentUI.formatContent) ? AgentUI.formatContent(partial) : this._paragraphs(partial);
    },

    _finish(item, key, entry) {
        this._saveSummary(key, { ...entry, v: this.SUMMARY_VERSION });
        this._set(item, entry);
    },

    /* ---------- related coverage ---------- */

    async _loadRelated(item, key, seedResults) {
        try {
            const title = String(item.title || '').trim();
            if (!title || !(await this._webOn())) return;
            let results = Array.isArray(seedResults) ? seedResults : null;
            if (!results) {
                this._patch(item, { relatedLoading: true });
                const resp = await this._searchWeb(this._cleanSubject(item.title, item.source || this._hostOf(item.url)).slice(0, 200));
                results = Array.isArray(resp?.results) ? resp.results : [];
            }
            const candidates = this._relatedCandidates(results, { selfUrls: [item.url, this._state?.openUrl], title });
            let related = [];
            if (candidates.length) {
                const picked = await this._pickRelated(title, candidates);
                related = picked || candidates.slice(0, this.RELATED_MAX).map(c => ({ ...c, kind: null, picked: false }));
            }
            this._persistRelated(key, related);
            this._patch(item, { relatedLoading: false, related });
        } catch {
            this._patch(item, { relatedLoading: false });
        }
    },

    /** Search results -> the shortlist the model may pick from: http(s)
     *  only, not the article itself, no aggregators, one row per site. */
    _relatedCandidates(results, opts = {}) {
        const selfUrls = new Set((opts.selfUrls || []).map(u => this._urlKey(u)).filter(Boolean));
        const selfTitle = this._normTitle(opts.title);
        const seenUrl = new Set(), seenHost = new Set(), seenTitle = new Set();
        const out = [];
        for (const r of (Array.isArray(results) ? results : [])) {
            const url = this._httpUrl(r?.url);
            if (!url) continue;
            const ukey = this._urlKey(url);
            if (!ukey || selfUrls.has(ukey) || seenUrl.has(ukey)) continue;
            const host = this._hostOf(url);
            if (!host || seenHost.has(host)) continue;
            if (this.RELATED_SKIP_HOSTS.some(h => host === h || host.endsWith('.' + h))) continue;
            const title = this._stripPublisherTail(
                this._cleanSubject(String(r?.title || '').replace(/\s+/g, ' ').trim(), host), host);
            const nt = this._normTitle(title);
            if (!nt || nt.length < 15 || seenTitle.has(nt) || nt === selfTitle) continue;
            seenUrl.add(ukey); seenHost.add(host); seenTitle.add(nt);
            out.push({
                title: title.slice(0, 180), url, site: host,
                snippet: String(r?.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 220),
                ...(r?.age ? { age: String(r.age).slice(0, 32) } : {})
            });
            if (out.length >= this.RELATED_CANDIDATES) break;
        }
        return out;
    },

    // The model picks by INDEX and tags a kind; every title and link comes
    // from the search. null when there is no model or the call fails.
    async _pickRelated(title, candidates) {
        if (!this._hasModel()) return null;
        try {
            const list = candidates.map((c, i) =>
                `${i}. ${c.title} — ${c.site}${c.age ? ` (${c.age})` : ''}\n   ${c.snippet}`).join('\n');
            const kinds = Object.keys(this.RELATED_KINDS);
            const res = await LLMLogger.call('portfolio-article-related', {
                model: AgentService.model,
                messages: [
                    { role: 'system', content: 'You choose which search results are worth a news reader\'s time. Respond with JSON only, no prose.' },
                    { role: 'user', content: `The reader just read this story:

Headline: ${title}

CANDIDATE LINKS (from a web search):
${list}

Pick up to ${this.RELATED_MAX} that a reader of that story would genuinely want next: another outlet covering the same story, background or an explainer that makes it make sense, or a directly related development. Order them by how useful they are, most useful first.

Leave out anything off-topic, a section or tag page, a home page, a sign-in or subscription page, a page that is only about a different story, and anything that is plainly the same article again. If none of them are worth it, return an empty list — that is a fine answer.

Tag each pick with one kind: ${kinds.join(', ')} (coverage = the same story from another outlet, background = context or an explainer, followup = what happened next).

Return JSON exactly like: {"related":[{"i":0,"kind":"coverage"}]}. Use only the numbers above; never write a title or a link.` }
                ],
                format: 'json',
                think: false,
                maxTokens: 200,
                options: { temperature: 0.1, num_ctx: AgentService.numCtx || 8192 },
                stream: false,
                jobClass: 'background',
                logTag: 'portfolio-article-related'
            });
            if (res?.error) return null;
            const text = String(res?.message?.content || '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
            let parsed = null;
            try { parsed = JSON.parse(text)?.related; } catch { return null; }
            return this._applyPicks(candidates, parsed);
        } catch { return null; }
    },

    _applyPicks(candidates, picks) {
        if (!Array.isArray(picks)) return null;
        const seen = new Set();
        const out = [];
        for (const p of picks) {
            const i = Number(p?.i ?? p?.index);
            if (!Number.isInteger(i) || i < 0 || i >= candidates.length || seen.has(i)) continue;
            seen.add(i);
            const k = String(p?.kind || '').toLowerCase();
            out.push({ ...candidates[i], kind: Object.prototype.hasOwnProperty.call(this.RELATED_KINDS, k) ? k : null, picked: true });
            if (out.length >= this.RELATED_MAX) break;
        }
        return out;
    },

    _validRelated(list) {
        if (!Array.isArray(list)) return [];
        const out = [];
        for (const r of list) {
            const url = this._httpUrl(r?.url);
            const title = String(r?.title || '').trim();
            if (!url || !title) continue;
            out.push({
                title: title.slice(0, 180), url, site: String(r?.site || this._hostOf(url)),
                kind: Object.prototype.hasOwnProperty.call(this.RELATED_KINDS, r?.kind) ? r.kind : null,
                picked: !!r?.picked,
                ...(r?.age ? { age: String(r.age).slice(0, 32) } : {})
            });
            if (out.length >= this.RELATED_MAX) break;
        }
        return out;
    },

    _persistRelated(key, related) {
        const all = this._summaries();
        if (!all[key]) return;
        all[key] = { ...all[key], related: related.map(({ title, url, site, kind, picked, age }) =>
            ({ title, url, site, kind, picked, ...(age ? { age } : {}) })) };
        StorageManager.set(this.SUMMARY_KEY, all);
    },

    // Rows in the Settings shape: the headline, who ran it, a kind; a click
    // reads it here, the arrow opens the browser.
    _relatedHtml(related, loading) {
        const esc = AppManager.escapeHtml;
        if (loading && !(related && related.length)) {
            return `<section class="pf-reader-section"><div class="pf-eyebrow">Related coverage</div><p class="pf-reader-working">Looking for related coverage…</p></section>`;
        }
        const rows = Array.isArray(related) ? related : [];
        if (!rows.length) return '';
        const picked = rows.some(r => r.picked);
        return `
            <section class="pf-reader-section">
                <div class="pf-eyebrow">Related coverage</div>
                <div class="pf-group">
                    ${rows.map((r, i) => `
                    <div class="pf-row pf-related-row" role="button" tabindex="0" data-related="${i}" title="Read it here">
                        <span class="pf-row-copy">
                            <span class="pf-row-label">${esc(r.title)}</span>
                            <span class="pf-row-sub">${[r.site || this._hostOf(r.url), r.kind ? this.RELATED_KINDS[r.kind] : '', r.age || ''].filter(Boolean).map(esc).join(' · ')}</span>
                        </span>
                        <button type="button" class="pf-related-ext" data-related-ext="${i}" title="Open in your browser" aria-label="Open in your browser"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg></button>
                    </div>`).join('')}
                </div>
                <p class="pf-reader-foot">${picked ? 'Picked by AI from a web search on this headline. Every headline and link is the publisher’s own.' : 'From a web search on this headline.'}</p>
            </section>`;
    },

    // A related story reads here; its way back is the story it came from,
    // and that one's way back is still where the reader was opened from.
    _openRelated(idx) {
        const r = this._state?.related?.[idx];
        if (!r) return;
        const from = this._current, fromBack = this._returnTo;
        const when = r.age && Number.isFinite(Date.parse(r.age)) ? r.age : null;
        const label = String(from?.title || 'the story');
        this.openReader({ title: r.title, url: r.url, source: r.site, publishedAt: when, topic: from?.topic || '' }, {
            returnTo: {
                label: label.length > 40 ? label.slice(0, 39).trimEnd() + '…' : label,
                onBack: () => this.openReader(from, { returnTo: fromBack })
            }
        });
    },

    /* ---------- the source block ---------- */

    // Built from real metadata (the page's head, else the feed) — never
    // from the model, which would invent a plausible URL and date.
    _sourceHtml(src) {
        if (!src || !src.url) return '';
        const esc = AppManager.escapeHtml;
        const rows = [];
        if (src.site) rows.push(['Source', esc(src.site)]);
        const pub = this._stamp(src.publishedAt);
        if (pub) rows.push(['Published', esc(pub)]);
        const upd = this._stamp(src.updatedAt);
        if (upd && upd !== pub) rows.push(['Updated', esc(upd)]);
        rows.push(['Article', `<button type="button" class="pf-link" data-reader="source" title="${esc(src.url)}">Open on ${esc(this._hostOf(src.url) || 'the web')}</button>`]);
        return `
            <section class="pf-reader-section">
                <div class="pf-eyebrow">Source</div>
                <dl class="pf-reader-source">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
            </section>`;
    },

    /* ---------- actions ---------- */

    _openArticle() {
        this._openUrl(this._state?.openUrl || this._current?.url);
    },

    _openUrl(url) {
        if (url && /^https?:/i.test(url)) AppManager.openExternal(url);
    },

    // A chat grounded in the article text (else the summary), told to search
    // for what the text does not cover when web access is on.
    async _ask() {
        const it = this._current;
        if (!it || typeof AgentService === 'undefined' || !AgentService.openScopedConversation) return;
        const st = this._state || {};
        const article = (this._articleText || '').slice(0, 6000);
        const summary = (st.summary || '').slice(0, 5000);
        const url = st.openUrl || it.url || '';
        const webOn = await this._webOn();
        const material = article
            ? `\nARTICLE TEXT (what the user read; may be truncated):\n${article}`
            : summary ? `\nWHAT THE USER READ (summary shown in the app):\n${summary}`
                : '\nNo article text was available; say so when it matters.';
        const reach = webOn
            ? `\n\nGround answers about the story in the text above. For anything it does not cover (background, what has happened since, other coverage), use web_search and read_url instead of answering from memory: this is a current story and your training data is behind it. Say when an answer came from a search.`
            : `\n\nGround answers about the story in the text above. Web search is off, so for anything beyond the text answer from general knowledge and say that is what you are doing.`;
        AppManager.openApp('agent');
        const conv = AgentService.openScopedConversation({
            extraContext: `This conversation is about a news article the user just read in Finance.\n`
                + `Headline: "${it.title}" (${st.source?.site || it.source || 'unknown source'}).\n`
                + (url ? `Article URL: ${url}\n` : '') + material + reach,
            greeting: `Let’s talk about **${it.title}**. I have the ${article ? 'article' : 'summary'} you just read${webOn ? ', and I can search for background or newer developments' : ''}. What would you like to know?`
        });
        if (conv) {
            conv.title = `Re: ${it.title}`.slice(0, 80);
            AgentService._saveConversations?.();
            // The greeting was pushed after creation: load it so the panel shows it.
            AgentService.loadConversation(conv.id);
        }
        if (typeof AgentUI !== 'undefined') { AgentUI.renderMessages?.(); AgentUI.renderHistorySidebar?.(); }
    },

    /* ---------- helpers ---------- */

    _summaries() {
        const d = StorageManager.get(this.SUMMARY_KEY);
        return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
    },

    // Every field the reader reads back is listed: a field not named here is
    // dropped on the way to disk.
    _saveSummary(key, entry) {
        const all = this._summaries();
        const prev = all[key];
        all[key] = {
            summary: entry.summary,
            mode: entry.mode,
            openUrl: entry.openUrl || '',
            source: entry.source || null,
            events: prev?.events,
            related: Array.isArray(entry.related) ? entry.related : prev?.related,
            v: entry.v,
            at: Date.now()
        };
        const keys = Object.keys(all);
        if (keys.length > this.SUMMARY_MAX) {
            keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
            for (const k of keys.slice(0, keys.length - this.SUMMARY_MAX)) delete all[k];
        }
        StorageManager.set(this.SUMMARY_KEY, all);
    },

    // Two 32-bit hashes (djb2 + sdbm): the News reader's key, so its cache
    // carries over.
    _hash(s) {
        const str = String(s || '');
        let h1 = 5381, h2 = 0;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            h1 = ((h1 << 5) + h1 + c) >>> 0;
            h2 = (c + (h2 << 6) + (h2 << 16) - h2) >>> 0;
        }
        return 'u' + h1.toString(36) + '-' + h2.toString(36);
    },

    _hostOf(url) {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
    },

    _httpUrl(u) {
        try {
            const x = new URL(String(u || '').trim());
            return (/^https?:$/i.test(x.protocol) && x.hostname.includes('.')) ? x.href : '';
        } catch { return ''; }
    },

    _urlKey(u) {
        const url = this._httpUrl(u);
        if (!url) return '';
        try {
            const x = new URL(url);
            return x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '').toLowerCase();
        } catch { return ''; }
    },

    _normTitle(t) {
        return String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    },

    // An absolute local time: under an article the reader wants the stamp.
    _stamp(when) {
        if (when == null || when === '') return '';
        const t = typeof when === 'number' ? when : Date.parse(when);
        if (!Number.isFinite(t)) return '';
        return new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    },

    // " - Publisher" tails come off a headline when they name the site.
    _cleanSubject(title, site) {
        let s = String(title || '').trim();
        const tails = [site, this._hostOf(site), (site || '').replace(/^the\s+/i, '')]
            .filter(Boolean).map(x => String(x).toLowerCase());
        for (const tail of tails) {
            const lower = s.toLowerCase();
            for (const sep of [' - ', ' | ', ' – ']) {
                if (lower.endsWith(sep + tail)) return s.slice(0, s.length - sep.length - tail.length).trim();
            }
        }
        return s;
    },

    // A search result's title ends in the masthead; the host names it.
    _stripPublisherTail(title, host) {
        const t = String(title || '').trim();
        const m = t.match(/^(.{20,}?)\s+[|–—·-]\s+([^|–—·]{2,40})$/);
        if (!m) return t;
        const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const label = norm(String(host || '').replace(/^www\./, '').split('.')[0]);
        const tail = norm(m[2]).replace(/^the/, '');
        if (!label || tail.length < 3) return t;
        return (label === tail || label.includes(tail) || tail.includes(label)) ? m[1].trim() : t;
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = PortfolioReader;
