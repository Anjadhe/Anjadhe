/**
 * Screen tools — the assistant SEES Anjadhe's own window and OPERATES it
 * (docs/COWORK_AGENT.md C13, 2026-09-12; main half js/main/screen-control.js).
 *
 *   screen_look  the window as the user sees it: a screenshot with a
 *                numbered box on every clickable element (attached only when
 *                the brain has vision) and the same numbers as a text list —
 *                role, label, state, region — which is all a text-only brain
 *                gets, plus the page's visible text.
 *   screen_act   one step — click an element (by number, or by screenshot
 *                pixel when the model can see), type into a field, press a
 *                key, scroll — then a fresh look rides the result, so the
 *                model reads the effect before its next step.
 *
 * Laws:
 *   S1  The assistant may SEE its own chat and every consent surface, but it
 *       may never TOUCH them (NO_TOUCH): approving its own permission ask is
 *       the one thing this feature must make impossible, and typing into a
 *       composer (the chat's, or Home's with its quick-start pills) would be
 *       the model writing the user's messages. Checked on
 *       the target element AND on the element actually under the point.
 *   S2  Every action asks (screen_act is an ASK tool); session/always grants
 *       apply — EXCEPT in a chat whose looks showed outside content (Inbox,
 *       Email AI, Browse): there every action asks, grants or not
 *       (AgentService._resolvePermission via sawOutsideContent). Injected
 *       words reach the model as pixels, which the turn-start untrusted
 *       check cannot see.
 *   S3  Both tools are untrusted-blocked and refuse ambient runs (routines):
 *       a screenshot carries every data class at once, and nobody watching
 *       is the wrong time to click.
 *   S4  Numbers belong to ONE look. Every act re-looks, and a number whose
 *       element left, moved under something or scrolled away is refused with
 *       a fresh look attached — never a click on whatever now sits there.
 *   S5  Only the window. Other Mac apps are run_applescript's job.
 */
const ScreenTools = {
    GROUP: 'screen',
    MAX_MARKS: 90,
    ELEMENTS_BUDGET: 4200,
    SCREEN_TEXT_MAX: 1500,
    SETTLE_MS: 450,

    NO_TOUCH: '#agent-panel, #agent-view, .dash-agent-hero, .agent-inline-ask, .agent-confirm, dialog:has(.agent-confirm), .modal:has(.agent-confirm), #applock-overlay, #lock-screen, .screen-agent-pulse',
    NO_TOUCH_MSG: 'That is the assistant\'s own chat or a permission prompt — you can never operate those. The user answers permission prompts.',

    SEMANTIC: 'a[href], button, input:not([type="hidden"]), textarea, select, summary, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="switch"], [role="radio"], [role="treeitem"], [tabindex]:not([tabindex="-1"])',

    _marks: [],                 // [{ n, el, rect, role, label, state, region }] — latest look only (S4)
    _scale: 1,                  // screenshot px per CSS px, from the latest capture
    _outsideConvs: new Set(),   // conversations whose looks showed outside content (S2)

    // ── Pure helpers (tests/screen-tools-test.js) ─────────────────────────

    /** The words that summon the group. */
    domainMatch(s) {
        s = String(s || '').toLowerCase();
        return /\bscreen ?shots?\b/.test(s)
            || /\b(on|at|of) (the|my|your|this) (screen|window)\b/.test(s)
            || /\bscreen\b/.test(s)
            || /\b(double[- ]?)?(click|tap)(s|ed|ing)?\b/.test(s)
            || /\bpress (the|that|this|enter|return|escape|esc|tab)\b/.test(s)
            || /\bscroll(s|ed|ing)?\b/.test(s)
            || /\bwhat (do|can) you see\b/.test(s)
            || /\b(ui|user interface)\b/.test(s)
            || /\b(fill|type)\b.{0,30}\b(field|box|form|input)\b/.test(s)
            || /\b(use|operate|drive|navigate) (the|this) app\b/.test(s)
            || /\b(do it|do that|show me) in the app\b/.test(s);
    },

    cleanLabel(str, max = 60) {
        const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
        return s.length > max ? s.slice(0, max - 1) + '…' : s;
    },

    /** The numbered element list as text, bounded so the tool-result trim
     *  never cuts it mid-line. Returns { text, shown }. */
    formatElements(marks, budget) {
        const lines = [];
        let used = 0, shown = 0;
        for (const m of marks || []) {
            const line = `[${m.n}] ${m.role}: ${m.label || '(no label)'}`
                + (m.context ? ` — for "${m.context}"` : '')
                + (m.state ? ` (${m.state})` : '')
                + (m.region && m.region !== 'page' ? ` — ${m.region}` : '');
            if (used + line.length + 1 > budget) break;
            lines.push(line);
            used += line.length + 1;
            shown++;
        }
        return { text: lines.join('\n'), shown };
    },

    _esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    },

    /** The consent dialog's line — names the element from the latest look. */
    describeAct(args = {}) {
        const a = (v) => this._esc(v);
        const mark = args.element != null
            ? this._marks.find(m => m.n === parseInt(args.element, 10)) : null;
        const target = mark
            ? ` <strong>${a(mark.label || mark.role)}</strong> (${a(mark.role)}${mark.region && mark.region !== 'page' ? `, ${a(mark.region)}` : ''})`
            : '';
        const where = this._appLabel ? ` in ${a(this._appLabel())}` : '';
        switch (String(args.action || '').toLowerCase()) {
            case 'click':
                return mark ? `Click${target}${where}.`
                    : `Click at (${a(Math.round(+args.x))}, ${a(Math.round(+args.y))}) on the screenshot${where}.`;
            case 'type': {
                const t = String(args.text || '');
                return `Type “${a(t.slice(0, 200))}${t.length > 200 ? '…' : ''}”${mark ? ` into${target}` : ''}${args.clear ? ', replacing what is there' : ''}${where}.`;
            }
            case 'press':
                return `Press <strong>${a(args.key || '')}</strong>${where}.`;
            case 'scroll':
                return `Scroll ${a(args.direction || 'down')}${target ? ` inside${target}` : ''}${where}.`;
            default:
                return `Operate the app window${where}.`;
        }
    },

    sawOutsideContent(convId) {
        return this._outsideConvs.has(convId || '*');
    },

    // ── DOM ────────────────────────────────────────────────────────────────

    _appLabel() {
        const id = (typeof AppManager !== 'undefined') ? AppManager.currentApp : null;
        if (!id) return 'Home';
        try {
            if (typeof AppManager.appLabel === 'function') return AppManager.appLabel(id) || id;
        } catch (_) { /* fall through */ }
        return id;
    },

    _blocked(el) {
        return !!(el && el.closest && el.closest(this.NO_TOUCH));
    },

    _region(el) {
        if (el.closest('dialog[open], [role="dialog"], .modal')) return 'dialog';
        if (el.closest('.app-titlebar')) return 'titlebar';
        if (el.closest('#app-sidenav')) return 'left nav';
        return 'page';
    },

    _roleOf(el) {
        const role = el.getAttribute('role');
        if (role) return role;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'dropdown';
        if (tag === 'textarea') return 'text field';
        if (tag === 'summary') return 'disclosure';
        if (tag === 'input') {
            const t = (el.type || 'text').toLowerCase();
            if (t === 'checkbox' || t === 'radio') return t;
            if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
            if (t === 'range') return 'slider';
            if (t === 'file') return 'file picker';
            return 'text field';
        }
        if (el.isContentEditable) return 'text editor';
        if (tag === 'label' && el.control) return this._roleOf(el.control);
        return 'clickable';
    },

    _labelOf(el) {
        const aria = el.getAttribute('aria-label');
        if (aria && aria.trim()) return this.cleanLabel(aria);
        const tag = el.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            const lab = el.labels && el.labels[0] && el.labels[0].innerText;
            return this.cleanLabel(lab || el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '');
        }
        const text = el.innerText;
        if (text && text.trim()) return this.cleanLabel(text);
        const title = el.getAttribute('title') || el.getAttribute('data-tooltip');
        if (title) return this.cleanLabel(title);
        const img = el.querySelector('img[alt]');
        if (img && img.alt) return this.cleanLabel(img.alt);
        const svgTitle = el.querySelector('svg title');
        if (svgTitle && svgTitle.textContent) return this.cleanLabel(svgTitle.textContent);
        if (el.isContentEditable) return this.cleanLabel(el.getAttribute('data-placeholder') || '');
        return '';
    },

    _stateOf(el) {
        const out = [];
        const control = (el.tagName === 'LABEL' && el.control) ? el.control : el;
        if (control.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
        if ((control.type === 'checkbox' || control.type === 'radio') && control.checked) out.push('checked');
        if (el.getAttribute('aria-checked') === 'true') out.push('checked');
        if (el.getAttribute('aria-selected') === 'true') out.push('selected');
        if (el.getAttribute('aria-pressed') === 'true') out.push('on');
        if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') out.push('current');
        if (el.getAttribute('aria-expanded') === 'true') out.push('expanded');
        if (el.classList.contains('active') || el.classList.contains('is-active')) out.push('active');
        const tag = el.tagName;
        if ((tag === 'INPUT' || tag === 'TEXTAREA') && this._roleOf(el) === 'text field') {
            if ((el.type || '').toLowerCase() === 'password') out.push('password');
            else if (el.value) out.push(`value: "${this.cleanLabel(el.value, 40)}"`);
            else out.push('empty');
        }
        if (tag === 'SELECT' && el.selectedOptions && el.selectedOptions[0]) {
            out.push(`value: "${this.cleanLabel(el.selectedOptions[0].text, 40)}"`);
        }
        if (el === document.activeElement && (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable)) out.push('focused');
        try { if (getComputedStyle(el).opacity === '0') out.push('shows on hover'); } catch (_) {}
        return [...new Set(out)].join(', ');
    },

    // The title of the nearest row/card around el: the longest other line of
    // the first ancestor whose text holds more than the label itself — never
    // another control's label ("Dismiss — for Read") and never a nav group
    // heading, so chrome gets no context at all.
    _contextOf(el, label) {
        let n = el.parentElement;
        for (let i = 0; n && n !== document.body && i < 6; i++, n = n.parentElement) {
            const controls = new Set([...n.querySelectorAll('button, a[href], [role="button"]')]
                .map(c => String(c.innerText || '').trim()).filter(Boolean));
            const lines = String(n.innerText || '').split('\n').map(l => l.trim())
                .filter(l => l && l !== label && l.length <= 90 && !controls.has(l));
            if (lines.length) return this.cleanLabel(lines.reduce((a, b) => (b.length > a.length ? b : a)), 50);
        }
        return '';
    },

    _visibleRect(el) {
        const r = el.getBoundingClientRect();
        if (r.width < 3 || r.height < 3) return null;
        if (r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) return null;
        return r;
    },

    // A point on the element that a click would actually land on — null when
    // something else (a modal, the chat panel, a sticky header) covers it.
    _hitPoint(el, r) {
        const left = Math.max(r.left, 0), right = Math.min(r.right, window.innerWidth - 1);
        const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, window.innerHeight - 1);
        if (right - left < 2 || bottom - top < 2) return null;
        const cy = (top + bottom) / 2;
        const tries = [[(left + right) / 2, cy], [left + Math.min(12, (right - left) / 3), cy]];
        for (const [x, y] of tries) {
            const hit = document.elementFromPoint(x, y);
            if (!hit || this._blocked(hit)) continue;
            if (hit === el || el.contains(hit) || (el.control && hit === el.control)) return { x, y };
        }
        return null;
    },

    _collect() {
        const found = [];
        const self = this;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
            acceptNode(el) {
                if (el.hidden || /^(script|style|template|noscript|svg|canvas|iframe)$/i.test(el.tagName)) return NodeFilter.FILTER_REJECT;
                if (el.classList.contains('view') && !el.classList.contains('active')) return NodeFilter.FILTER_REJECT;
                if (el.matches(self.NO_TOUCH)) return NodeFilter.FILTER_REJECT;
                if (el.offsetParent === null && el !== document.body) {
                    const d = getComputedStyle(el).display;
                    if (d === 'none') return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        let el;
        while ((el = walker.nextNode())) {
            const semantic = el.matches(this.SEMANTIC);
            if (semantic) {
                // A control nested inside a clickable link/button is the same
                // target twice; form controls stay (they take text).
                const outer = el.parentElement && el.parentElement.closest('a[href], button, [role="button"]');
                if (outer && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) continue;
            } else {
                // cursor is inherited: a pointer element counts only where the
                // pointer STARTS, not on every descendant under it.
                const cs = getComputedStyle(el);
                if (cs.cursor !== 'pointer') continue;
                const parent = el.parentElement;
                if (parent && getComputedStyle(parent).cursor === 'pointer') continue;
                if (el.closest('a[href], button, [role="button"]')) continue;
            }
            const r = this._visibleRect(el);
            if (!r) continue;
            try {
                if (typeof el.checkVisibility === 'function'
                    && !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) continue;
            } catch (_) { /* older engines: rect + hit test decide */ }
            const pt = this._hitPoint(el, r);
            if (!pt) continue;
            found.push({ el, rect: r, region: this._region(el) });
            if (found.length >= this.MAX_MARKS * 2) break;
        }
        // Grouped by region, most relevant first (an open dialog, then the
        // page, then the app's chrome), reading order inside each — a list
        // that interleaves nav rows with page rows reads as noise to a
        // text-only model, and the cap should cut chrome before content.
        const order = { dialog: 0, page: 1, 'left nav': 2, titlebar: 3 };
        found.sort((a, b) => (order[a.region] - order[b.region])
            || (Math.round(a.rect.top / 12) - Math.round(b.rect.top / 12)) || (a.rect.left - b.rect.left));
        return found;
    },

    async _canSee(ctx) {
        if (typeof AgentService !== 'undefined' && typeof AgentService.ensureVisionInfo === 'function') {
            try { await AgentService.ensureVisionInfo(); } catch (_) { /* supportsVision falls back */ }
        }
        return typeof AgentService !== 'undefined' && typeof AgentService.supportsVision === 'function'
            && AgentService.supportsVision(AgentService.getActiveEntry(ctx && ctx.convId));
    },

    _screenText() {
        const parts = [];
        const dialog = [...document.querySelectorAll('dialog[open]')].filter(d => !this._blocked(d)).pop();
        if (dialog) parts.push('DIALOG: ' + dialog.innerText);
        const view = document.querySelector('.view.active');
        if (view && !this._blocked(view)) parts.push(view.innerText);
        const text = parts.join('\n\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        return text.length > this.SCREEN_TEXT_MAX ? text.slice(0, this.SCREEN_TEXT_MAX) + '…' : text;
    },

    /**
     * Draw numbered boxes on a screenshot. boxes: [{n, x, y, w, h}] in the
     * source's units (CSS px for this window, points for another app's);
     * sourceWidth is the image's width in those units. Returns the JPEG and
     * the image-px-per-unit scale a pixel click divides by.
     */
    async drawMarks(dataUrl, boxes, sourceWidth) {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const g = canvas.getContext('2d');
        g.drawImage(img, 0, 0);
        const s = sourceWidth > 0 ? canvas.width / sourceWidth : 1;
        const fontPx = Math.max(11, Math.round(11 * s));
        g.font = `700 ${fontPx}px -apple-system, BlinkMacSystemFont, sans-serif`;
        g.textBaseline = 'top';
        for (const b of boxes) {
            const x = b.x * s, y = b.y * s, w = b.w * s, h = b.h * s;
            g.strokeStyle = 'rgba(230, 0, 110, 0.9)';
            g.lineWidth = Math.max(1.5, 1.25 * s);
            g.strokeRect(x, y, w, h);
            const label = String(b.n);
            const tw = g.measureText(label).width + 6;
            const th = fontPx + 3;
            let ly = y - th;
            if (ly < 0) ly = y;
            g.fillStyle = '#e6006e';
            g.fillRect(x, ly, tw, th);
            g.fillStyle = '#ffffff';
            g.fillText(label, x + 3, ly + 2);
        }
        return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), scale: s };
    },

    async _drawMarks(shot, marks) {
        const boxes = marks.map(m => ({ n: m.n, x: m.rect.left, y: m.rect.top, w: m.rect.width, h: m.rect.height }));
        const drawn = await this.drawMarks(shot.dataUrl, boxes, window.innerWidth);
        this._scale = drawn.scale;
        return drawn.dataUrl;
    },

    async look(ctx = {}) {
        if (ctx.ambient) return { error: 'Seeing the screen is not available in background runs.' };
        if (!window.electronScreen) return { error: 'Screen tools need the Anjadhe desktop app.' };
        document.querySelectorAll('.screen-agent-pulse').forEach(p => p.remove());

        const found = this._collect();
        this._marks = found.slice(0, this.MAX_MARKS).map((f, i) => ({
            n: i + 1,
            el: f.el,
            rect: f.rect,
            role: this._roleOf(f.el),
            label: this._labelOf(f.el),
            state: this._stateOf(f.el),
            region: f.region
        }));
        // "Done", "Open" ×6: a repeated label says nothing on its own, so it
        // carries the title of the row it sits in.
        const counts = {};
        for (const m of this._marks) counts[m.label] = (counts[m.label] || 0) + 1;
        for (const m of this._marks) {
            if (counts[m.label] > 1 && (m.region === 'page' || m.region === 'dialog')) {
                const c = this._contextOf(m.el, m.label);
                if (c) m.context = c;
            }
        }

        const appId = (typeof AppManager !== 'undefined') ? AppManager.currentApp : null;
        if (typeof AgentService !== 'undefined' && AgentService.UNTRUSTED_CONTEXT_APPS
            && AgentService.UNTRUSTED_CONTEXT_APPS.has(appId)) {
            this._outsideConvs.add(ctx.convId || '*');
        }

        const list = this.formatElements(this._marks, this.ELEMENTS_BUDGET);
        const out = {
            app: this._appLabel(),
            elements: list.text || '(no clickable elements are visible)'
        };
        const hidden = found.length - list.shown;
        if (hidden > 0) out.moreElements = `${hidden} more clickable element(s) were not numbered — scroll, or close what covers them, to reach them.`;
        if (appId === 'agent') {
            out.note = 'The Assistant chat fills the window, and you cannot operate it. Open another app from the left nav to work in it.';
        }
        if (await this._canSee(ctx)) {
            const shot = await window.electronScreen.capture();
            if (shot && shot.dataUrl) {
                out.images = [{ dataUrl: await this._drawMarks(shot, this._marks) }];
                out.howToRead = 'Each pink number on the screenshot matches an element above. Act on elements by number.';
            } else {
                out.imageError = (shot && shot.error) || 'The screenshot failed.';
                out.screenText = this._screenText();
            }
        } else {
            out.screenText = this._screenText();
            out.howToRead = 'You cannot view images, so this is the screen as text: the visible page text and its numbered elements.';
        }
        return out;
    },

    // S4: resolve a number from the latest look to a live, uncovered point.
    _target(n) {
        const num = parseInt(n, 10);
        const mark = this._marks.find(m => m.n === num);
        if (!mark) return { error: `There is no element [${n}] in the latest look — use a number from the most recent result.`, stale: true };
        if (!mark.el.isConnected) return { error: `Element [${num}] (${mark.label || mark.role}) is gone — the screen changed.`, stale: true };
        if (this._blocked(mark.el)) return { error: this.NO_TOUCH_MSG };
        const r = this._visibleRect(mark.el);
        const pt = r && this._hitPoint(mark.el, r);
        if (!pt) return { error: `Element [${num}] (${mark.label || mark.role}) cannot be reached right now — it scrolled away or something covers it.`, stale: true };
        return { mark, pt };
    },

    _editableIn(el) {
        const ok = (e) => e && (e.isContentEditable || e.tagName === 'TEXTAREA'
            || (e.tagName === 'INPUT' && this._roleOf(e) === 'text field'));
        if (ok(el)) return el;
        if (el && el.tagName === 'LABEL' && ok(el.control)) return el.control;
        return el ? [...el.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""]')].find(ok) || null : null;
    },

    _scrollerFrom(el) {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (/(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
        }
        return document.scrollingElement;
    },

    _pulse(pt) {
        const dot = document.createElement('div');
        dot.className = 'screen-agent-pulse';
        dot.style.left = pt.x + 'px';
        dot.style.top = pt.y + 'px';
        document.body.appendChild(dot);
        setTimeout(() => dot.remove(), 400);
    },

    async _withLook(result, ctx) {
        const fresh = await this.look(ctx);
        const { error: lookError, ...rest } = fresh;
        return { ...result, ...rest, ...(lookError ? { lookError } : {}) };
    },

    async act(args = {}, ctx = {}) {
        if (ctx.ambient) return { error: 'Using the screen is not available in background runs.' };
        if (!window.electronScreen) return { error: 'Screen tools need the Anjadhe desktop app.' };
        const action = String(args.action || '').toLowerCase();
        let did;

        if (action === 'click') {
            let pt, mark = null;
            if (args.element != null && args.element !== '') {
                const t = this._target(args.element);
                if (t.error) return t.stale ? this._withLook({ error: t.error }, ctx) : { error: t.error };
                ({ mark, pt } = t);
            } else if (Number.isFinite(+args.x) && Number.isFinite(+args.y)) {
                pt = { x: +args.x / (this._scale || 1), y: +args.y / (this._scale || 1) };
                const hit = document.elementFromPoint(pt.x, pt.y);
                if (!hit) return { error: 'That point is outside the window.' };
                if (this._blocked(hit)) return { error: this.NO_TOUCH_MSG };
            } else {
                return { error: 'click needs element (a number from the latest look), or x and y in screenshot pixels.' };
            }
            this._pulse(pt);
            const res = await window.electronScreen.input({ type: 'click', x: pt.x, y: pt.y });
            if (res && res.error) return { error: res.error };
            did = mark ? `Clicked [${mark.n}] ${mark.role}: ${mark.label || '(no label)'}` : `Clicked at (${Math.round(+args.x)}, ${Math.round(+args.y)})`;
        } else if (action === 'type') {
            const text = typeof args.text === 'string' ? args.text : '';
            if (!text) return { error: 'type needs text.' };
            let field = null, mark = null;
            if (args.element != null && args.element !== '') {
                const t = this._target(args.element);
                if (t.error) return t.stale ? this._withLook({ error: t.error }, ctx) : { error: t.error };
                mark = t.mark;
                field = this._editableIn(mark.el);
                if (!field) return { error: `Element [${mark.n}] (${mark.label || mark.role}) is not a text field.` };
                field.focus();
            } else {
                field = this._editableIn(document.activeElement);
                if (!field || field !== document.activeElement) {
                    return { error: 'No text field has focus — pass element with the field\'s number.' };
                }
            }
            if (this._blocked(field)) return { error: this.NO_TOUCH_MSG };
            if ((field.type || '').toLowerCase() === 'password') return { error: 'You may not type into password fields — ask the user to enter it.' };
            if (field.isContentEditable) {
                const range = document.createRange();
                range.selectNodeContents(field);
                if (!args.clear) range.collapse(false);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            } else if (args.clear) {
                field.select();
            } else {
                try { const len = field.value.length; field.setSelectionRange(len, len); } catch (_) { /* number/date inputs */ }
            }
            const res = await window.electronScreen.input({ type: 'type', text });
            if (res && res.error) return { error: res.error };
            const shown = text.length > 60 ? text.slice(0, 59) + '…' : text;
            did = `Typed "${shown}"` + (mark ? ` into [${mark.n}] ${mark.label || mark.role}` : '') + (args.clear ? ' (replaced)' : '');
        } else if (action === 'press') {
            if (!args.key) return { error: 'press needs key, e.g. "Enter", "Escape" or "Down".' };
            // Focus sitting in the chat (the composer the user just sent
            // from) must not receive the key — S1. Drop it to the page.
            if (document.activeElement && document.activeElement !== document.body && this._blocked(document.activeElement)) {
                document.activeElement.blur();
            }
            const res = await window.electronScreen.input({ type: 'key', key: String(args.key) });
            if (res && res.error) return { error: res.error };
            did = `Pressed ${args.key}`;
        } else if (action === 'scroll') {
            const dir = String(args.direction || 'down').toLowerCase();
            if (dir !== 'up' && dir !== 'down') return { error: 'direction must be up or down.' };
            let anchor = null;
            if (args.element != null && args.element !== '') {
                const t = this._target(args.element);
                if (t.error) return t.stale ? this._withLook({ error: t.error }, ctx) : { error: t.error };
                anchor = t.mark.el;
            } else {
                const view = document.querySelector('.view.active');
                const r = view && view.getBoundingClientRect();
                anchor = r ? document.elementFromPoint(r.left + Math.min(r.width / 2, 300), r.top + r.height / 2) : null;
            }
            if (!anchor || this._blocked(anchor)) return { error: 'There is nothing on the page to scroll there.' };
            const scroller = this._scrollerFrom(anchor);
            const before = scroller.scrollTop;
            scroller.scrollBy({ top: (dir === 'down' ? 1 : -1) * Math.round(scroller.clientHeight * 0.8), behavior: 'instant' });
            did = scroller.scrollTop !== before ? `Scrolled ${dir}` : `Could not scroll ${dir} — already at the ${dir === 'down' ? 'bottom' : 'top'}`;
        } else {
            return { error: 'action must be click, type, press or scroll.' };
        }

        // Let the app react (a view switch, a re-render) before looking.
        // setTimeout, not rAF: rAF never fires in an occluded window.
        await new Promise(r => setTimeout(r, this.SETTLE_MS));
        return this._withLook({ did }, ctx);
    }
};

(function registerScreenTools() {
    if (typeof AgentTools === 'undefined') return;
    const GROUP = ScreenTools.GROUP;
    AgentTools.registerDomain(GROUP, (s) => ScreenTools.domainMatch(s));

    AgentTools.register({
        type: 'function', function: {
            name: 'screen_look',
            description: 'See the Anjadhe app window right now, the way the user sees it: a screenshot (attached when you can view images) with a pink NUMBER on every clickable element, plus those numbered elements as text (role, label, state, region). Use it to see what the user is looking at, and before operating the app with screen_act. Covers this app\'s own window only — not other Mac apps.',
            parameters: { type: 'object', properties: {} }
        }
    }, async function screen_look(args, ctx) {
        return ScreenTools.look(ctx);
    }, { source: 'screen', group: GROUP, blockUntrusted: true });

    AgentTools.register({
        type: 'function', function: {
            name: 'screen_act',
            description: 'Operate the Anjadhe app window like the user would, ONE step per call: click an element, type into a text field, press a key, or scroll. Refer to elements by their NUMBER from the LATEST screen_look or screen_act result — numbers change after every step. Every call returns a fresh look, so check what happened before the next step. The user approves these actions.',
            parameters: { type: 'object', properties: {
                action: { type: 'string', enum: ['click', 'type', 'press', 'scroll'], description: 'What to do' },
                element: { type: 'integer', description: 'The element\'s number from the latest look (click; type — focuses that field first; scroll — scrolls the area containing it)' },
                x: { type: 'number', description: 'click only, when the target has no number: x in screenshot pixels (only if you can view the screenshot)' },
                y: { type: 'number', description: 'click only, when the target has no number: y in screenshot pixels' },
                text: { type: 'string', description: 'type: the text to enter' },
                clear: { type: 'boolean', description: 'type: replace what the field already holds instead of adding to it' },
                key: { type: 'string', description: 'press: Enter, Escape, Tab, Backspace, Delete, Space, Up, Down, Left, Right, PageUp, PageDown, Home, End, or a combo like cmd+a' },
                direction: { type: 'string', enum: ['up', 'down'], description: 'scroll direction (default down)' }
            }, required: ['action'] }
        }
    }, async function screen_act(args, ctx) {
        return ScreenTools.act(args, ctx);
    }, {
        source: 'screen', group: GROUP, ask: true, blockUntrusted: true,
        describe: (args) => ScreenTools.describeAct(args)
    });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ScreenTools;
