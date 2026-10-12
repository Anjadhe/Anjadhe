/**
 * RecordMention — @-mention a record from the assistant composers
 * (2026-08-19).
 *
 * Typing "@" at a word start in any assistant composer (#agent-input,
 * #agent-app-input, #dash-agent-input) opens an autosuggest popover over
 * the user's own records. Picking one does TWO things: inserts the
 * record's title as plain text (so the sentence still reads naturally and
 * the model sees the name), and ATTACHES the conversation to that record
 * (conv.recordKey) — which is what makes the mention mean something: the
 * existing record-attachment machinery injects the CURRENT <TYPE> context
 * block and the record's saved decisions on every turn, and pre-scopes
 * the record type's tool domains (AgentService._seedRecordDomains).
 *
 * The mentionable types are EXACTLY the types with an AgentContext record
 * resolver — task, goal, note, routine, strategy, account. External-
 * content records (email, insight, browse) are deliberately absent, the
 * same law as the resolvers themselves: their context blocks carry
 * attacker-supplied text and must never be pulled into a chat by a
 * lightweight affordance. Holdings are not records (derived — the
 * GlobalSearch rule); the account is what you mention.
 *
 * Attachment timing: with an active conversation the attach happens on
 * select (last mention wins — the user is declaring the chat's subject,
 * and the banner above the composer shows it immediately). From the home
 * composer, or with no conversation yet, it is stored as PENDING and
 * consumed at dispatch (consumePending) — the home flow calls
 * openFreshConversation at submit, so anything attached earlier would be
 * left behind on a conversation the message never lands in.
 */

const RecordMention = {
    COMPOSERS: new Set(['agent-input', 'agent-app-input', 'dash-agent-input']),
    MAX_ROWS: 8,

    _el: null,          // popover element (created once, body-appended)
    _openFor: null,     // the textarea the popover is open for
    _tokenStart: -1,    // index of '@' in the textarea value
    _items: [],
    _active: 0,
    pending: null,      // { key, label } — attach at dispatch (home composer)

    init() {
        if (this._inited) return;
        this._inited = true;

        document.addEventListener('input', (e) => {
            const t = e.target;
            if (t && this.COMPOSERS.has(t.id)) this._onInput(t);
        });

        // CAPTURE phase: must win over the composers' own Enter-to-send
        // handlers (document-level for the agent inputs, element-level for
        // the home composer) — capture fires before both.
        document.addEventListener('keydown', (e) => {
            if (!this._openFor || e.target !== this._openFor) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault(); e.stopPropagation();
                const d = e.key === 'ArrowDown' ? 1 : -1;
                this._active = (this._active + d + this._items.length) % this._items.length;
                this._paintActive();
            } else if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault(); e.stopPropagation();
                this._select(this._items[this._active]);
            } else if (e.key === 'Escape') {
                e.preventDefault(); e.stopPropagation();
                this._close();
            }
        }, true);

        // Click elsewhere closes; row clicks select on mousedown so the
        // textarea never loses focus first.
        document.addEventListener('mousedown', (e) => {
            if (this._el && !this._el.contains(e.target) && e.target !== this._openFor) this._close();
        });
        window.addEventListener('resize', () => this._close());
    },

    // ── trigger detection ────────────────────────────────────────────────

    _onInput(el) {
        const upto = el.value.slice(0, el.selectionStart ?? el.value.length);
        // '@' at a word start only — "ram.b@gmail.com" must never trigger.
        const m = upto.match(/(^|\s)@([^\n@]{0,60})$/);
        if (!m) { this._close(); return; }
        this._tokenStart = upto.length - m[2].length - 1;
        const items = this._candidates(m[2]);
        // With an explicit type filter an empty result stays OPEN ("No
        // goals match") — silently closing would read as the syntax
        // failing. An unfiltered miss just closes.
        if (!items.length && !this._typeFilter) { this._close(); return; }
        this._items = items;
        this._active = 0;
        this._openFor = el;
        this._render(el);
    },

    // ── candidates ───────────────────────────────────────────────────────

    // One row per mentionable record: { key, type, title, sub, body, recency }.
    // key is the exact conv.recordKey format each app's resolver registered.
    _index() {
        // One table of record types (js/core/record-types.js): built-ins
        // and app packages alike. Rows carry the label as `type`.
        const out = [];
        for (const d of RecordTypes.mentionable()) {
            let rows = [];
            try { rows = d.index() || []; } catch (e) { console.warn('[mention] index failed:', d.type, e); }
            for (const r of rows) {
                out.push({ key: d.recordKey(r.id), type: d.label, title: r.title || '(untitled)',
                    sub: r.sub || '', body: r.body || '', recency: r.recency || '' });
            }
        }
        return out;
    },

    // "@goal run" / "@goal: run" narrows to one type — with 36 "Run N mi"
    // tasks in a goal, an unfiltered "@run" is a wall of tasks and the one
    // goal about running is unfindable. The first token filters ONLY when
    // it exactly equals a type word (singular or plural), so ordinary
    // searches are untouched; the popover's hint row teaches the syntax.
    get TYPE_WORDS() { return RecordTypes.words(); },

    // Rows a single type may take in an UNFILTERED list before other types
    // get their slots — one flooding type must never hide a differently-
    // typed match (the 36-run-tasks-bury-the-goal failure).
    TYPE_CAP: 3,

    _parseQuery(raw) {
        // First token is a COMPLETE type word ("@goal", "@goal run",
        // "@goal: run") → filter; a prefix mid-typing ("@goa") stays a
        // normal search.
        const m = String(raw || '').match(/^(\w+)(?::\s*|\s+|$)([\s\S]*)$/);
        const type = m ? this.TYPE_WORDS[m[1].toLowerCase()] : null;
        return type ? { type, query: m[2] } : { type: null, query: raw };
    },

    _candidates(raw) {
        const { type, query } = this._parseQuery(raw);
        this._typeFilter = type;
        let all = this._index();
        if (type) all = all.filter(it => it.type === type);

        const terms = (typeof GlobalSearch !== 'undefined')
            ? GlobalSearch._terms(query)
            : String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
        if (!terms.length) {
            // Bare "@" (or a bare type filter): most recently touched — a
            // stable, cheap default for "the thing I was just working on".
            return all.sort((a, b) => String(b.recency).localeCompare(String(a.recency)))
                .slice(0, this.MAX_ROWS);
        }
        const score = (it) => (typeof GlobalSearch !== 'undefined')
            ? GlobalSearch._score(terms, it.title, it.body)
            : (terms.every(t => (it.title + ' ' + it.body).toLowerCase().includes(t)) ? 1 : 0);
        const ranked = all.map(it => ({ ...it, score: score(it) }))
            .filter(it => it.score > 0)
            .sort((a, b) => b.score - a.score
                || String(b.recency).localeCompare(String(a.recency)));
        if (type) return ranked.slice(0, this.MAX_ROWS);

        // Type-diverse fill: first pass respects the per-type cap, second
        // pass tops up any spare slots with the best of the overflow —
        // so the list stays full when only one type matches at all.
        const taken = [];
        const counts = {};
        const overflow = [];
        for (const it of ranked) {
            if (taken.length >= this.MAX_ROWS) break;
            if ((counts[it.type] || 0) < this.TYPE_CAP) {
                counts[it.type] = (counts[it.type] || 0) + 1;
                taken.push(it);
            } else {
                overflow.push(it);
            }
        }
        for (const it of overflow) {
            if (taken.length >= this.MAX_ROWS) break;
            taken.push(it);
        }
        // Keep score order — diversity changes WHO gets in, not the order.
        return taken.sort((a, b) => b.score - a.score
            || String(b.recency).localeCompare(String(a.recency)));
    },

    // ── popover ──────────────────────────────────────────────────────────

    _ensureEl() {
        if (this._el) return this._el;
        const el = document.createElement('div');
        el.id = 'record-mention-pop';
        el.className = 'record-mention-pop';
        el.hidden = true;
        document.body.appendChild(el);
        el.addEventListener('mousedown', (e) => {
            const row = e.target.closest('.record-mention-row');
            if (!row) return;
            e.preventDefault();   // keep composer focus
            this._select(this._items[parseInt(row.dataset.idx, 10)]);
        });
        this._el = el;
        return el;
    },

    _render(anchor) {
        const el = this._ensureEl();
        const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const rows = this._items.map((it, i) => `
            <button type="button" class="record-mention-row${i === this._active ? ' is-active' : ''}" data-idx="${i}">
                <span class="record-mention-type">${esc(it.type)}</span>
                <span class="record-mention-title">${esc(it.title)}</span>
                ${it.sub ? `<span class="record-mention-sub">${esc(it.sub)}</span>` : ''}
            </button>`).join('');
        const plural = this._typeFilter
            ? (RecordTypes.all().find(d => d.label === this._typeFilter)?.plural || this._typeFilter.toLowerCase() + 's') : '';
        const empty = !this._items.length && this._typeFilter
            ? `<div class="record-mention-empty">No ${esc(plural)} match</div>` : '';
        // The hint teaches the type filter exactly when it would help —
        // a mixed unfiltered list; a filtered one already shows its type
        // on every row.
        const hint = !this._typeFilter && new Set(this._items.map(it => it.type)).size > 1
            ? `<div class="record-mention-hint">Narrow by type: ${RecordTypes.mentionable().map(d => '@' + esc(d.words[0])).join('&ensp;')} — then your search</div>` : '';
        el.innerHTML = rows + empty + hint;
        el.hidden = false;

        // Above the composer when there's room (the chat composers sit at
        // the bottom of their surface), below it otherwise (home masthead).
        const r = anchor.getBoundingClientRect();
        el.style.width = Math.min(440, Math.max(280, r.width)) + 'px';
        el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8)) + 'px';
        const h = el.offsetHeight;
        if (r.top > h + 16) {
            el.style.top = (r.top - h - 6) + 'px';
        } else {
            el.style.top = (r.bottom + 6) + 'px';
        }
    },

    _paintActive() {
        if (!this._el) return;
        this._el.querySelectorAll('.record-mention-row').forEach((row, i) => {
            row.classList.toggle('is-active', i === this._active);
        });
        this._el.querySelector('.record-mention-row.is-active')
            ?.scrollIntoView({ block: 'nearest' });
    },

    _close() {
        if (this._el) { this._el.hidden = true; this._el.innerHTML = ''; }
        this._openFor = null;
        this._items = [];
        this._typeFilter = null;
        this._tokenStart = -1;
    },

    // ── selection ────────────────────────────────────────────────────────

    _select(item) {
        const el = this._openFor;
        if (!el || !item) { this._close(); return; }

        // Replace the "@query" token with the record's title, plain text.
        const caret = el.selectionStart ?? el.value.length;
        el.value = el.value.slice(0, this._tokenStart) + item.title + el.value.slice(caret);
        const pos = this._tokenStart + item.title.length;
        el.setSelectionRange(pos, pos);
        if (typeof AgentUI !== 'undefined') AgentUI._autoGrowComposer?.(el);

        // Attach. The home composer opens a FRESH conversation at submit,
        // so attaching now would tag a conversation the message never
        // lands in — pending is consumed at dispatch instead. Same for a
        // chat surface with no conversation yet.
        const convId = (typeof AgentService !== 'undefined') ? AgentService.activeConversationId : null;
        if (el.id === 'dash-agent-input' || !convId) {
            this.pending = { key: item.key, label: item.title };
        } else {
            AgentService.attachRecordToConversation(convId, item.key, item.title);
            if (typeof AgentUI !== 'undefined') {
                AgentUI.updateRecordBanner?.();
                AgentUI.renderHistorySidebar?.();
            }
        }

        this._close();
        el.focus();
    },

    /**
     * Called by AgentUI at dispatch/queue time, once a conversation is
     * guaranteed to exist — attaches any pending mention to it.
     */
    consumePending(convId) {
        if (!this.pending || !convId || typeof AgentService === 'undefined') return;
        const p = this.pending;
        this.pending = null;
        AgentService.attachRecordToConversation(convId, p.key, p.label);
        if (typeof AgentUI !== 'undefined') {
            AgentUI.updateRecordBanner?.();
            AgentUI.renderHistorySidebar?.();
        }
    }
};
