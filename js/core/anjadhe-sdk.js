/** Shared helpers and cross-app APIs for built-in packages. */

const Anjadhe = {
    version: 1,

    navigate(appName) {
        AppManager.openApp(appName);
    },

    // ── Cross-app APIs (docs/PLATFORM.md "App packages", 2026-08-29) ──
    //
    // The seam through which one app package acts on another's data. An
    // app EXPOSES a small named API (Schedule: create a task, start/stop
    // its timer, complete it); another USES it by name and gets null when
    // that app is not installed — so a package never holds a reference to
    // another app's object, and the shell never knows which apps talk.
    _apis: {},

    expose(name, api) {
        if (!name || !api || typeof api !== 'object') return false;
        this._apis[name] = api;
        return true;
    },

    use(name) {
        return this._apis[name] || null;
    },

    unexpose(name) { delete this._apis[name]; },

    showDashboard() {
        AppManager.showDashboard();
    },

    ui: {
        escapeHtml(text) {
            return UIUtils.escapeHtml(text);
        },

        // Brief feedback toast (reuses the host's toast). type: success|error|info.
        toast(message, type = 'success') {
            try { UIUtils.showToast(message, type); } catch {}
        },

        // Debounce a function — essential for text-driven lookups so a request
        // doesn't fire on every keystroke.
        debounce(fn, ms = 250) {
            let t;
            return function (...args) {
                clearTimeout(t);
                t = setTimeout(() => fn.apply(this, args), ms);
            };
        },

        /**
         * fetch a URL and return parsed JSON, with a timeout and normalized
         * errors so callers can just try/catch. Use for public, CORS-enabled
         * web APIs (e.g. Open Library). Throws Error('…') on failure.
         */
        async fetchJson(url, opts = {}) {
            const { timeoutMs = 10000, ...rest } = opts;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await fetch(url, { ...rest, signal: controller.signal });
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                return await res.json();
            } catch (e) {
                throw new Error(e.name === 'AbortError' ? 'Request timed out' : (e.message || 'Network request failed'));
            } finally {
                clearTimeout(timer);
            }
        },

        /**
         * Attach debounced async autocomplete to a text input — the fiddly
         * widget (dropdown, keyboard nav, outside-click dismiss, stale-result
         * guarding) so app code only supplies the data and the action:
         *   Anjadhe.ui.autocomplete(input, {
         *     search:   async q => [ {label, ...}, ... ],   // your fetch
         *     onSelect: item => { ...save it, rerender... },
         *     renderItem?: item => 'text',  // defaults to item.label/title
         *     minChars?: 2, debounceMs?: 250
         *   });
         * The input's parent is used to position the menu — keep the input in
         * its own container.
         */
        autocomplete(input, opts = {}) {
            if (!input) return;
            const { search, onSelect, renderItem, minChars = 2, debounceMs = 250 } = opts;
            if (typeof search !== 'function' || typeof onSelect !== 'function') return;

            const host = input.parentElement || input;
            if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
            const menu = document.createElement('div');
            menu.className = 'anjadhe-ac-menu';
            menu.hidden = true;
            host.appendChild(menu);

            let items = [];
            let active = -1;
            let seq = 0;
            const close = () => { menu.hidden = true; menu.innerHTML = ''; items = []; active = -1; };
            const place = () => {
                menu.style.top = (input.offsetTop + input.offsetHeight) + 'px';
                menu.style.left = input.offsetLeft + 'px';
                menu.style.width = input.offsetWidth + 'px';
            };
            const choose = (i) => {
                const it = items[i];
                if (!it) return;
                close();
                input.value = '';
                try { onSelect(it); } catch (e) { console.error('[autocomplete] onSelect threw:', e); }
            };
            // A single non-selectable row: "Searching…", "No results", errors.
            const showStatus = (text, kind) => {
                items = [];
                active = -1;
                menu.innerHTML = '';
                const row = document.createElement('div');
                row.className = 'anjadhe-ac-status' + (kind ? ` anjadhe-ac-${kind}` : '');
                row.textContent = text;
                menu.appendChild(row);
                place();
                menu.hidden = false;
            };
            const paint = () => {
                menu.innerHTML = '';
                items.forEach((it, i) => {
                    const row = document.createElement('div');
                    row.className = 'anjadhe-ac-item' + (i === active ? ' active' : '');
                    row.textContent = renderItem ? String(renderItem(it)) : String(it.label || it.title || it.name || it);
                    row.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
                    menu.appendChild(row);
                });
                if (items.length) { place(); menu.hidden = false; } else { close(); }
            };
            const run = this.debounce(async (q) => {
                const mySeq = ++seq;
                showStatus('Searching…', 'loading');
                try {
                    const results = await search(q);
                    if (mySeq !== seq) return; // a newer query superseded this one
                    items = Array.isArray(results) ? results.slice(0, 8) : [];
                    active = -1;
                    if (!items.length) { showStatus('No results', 'empty'); return; }
                    paint();
                } catch {
                    if (mySeq !== seq) return;
                    showStatus('Search failed', 'error');
                }
            }, debounceMs);

            input.addEventListener('input', () => {
                const q = input.value.trim();
                if (q.length < minChars) { close(); return; }
                // Immediate feedback even before the debounced fetch fires.
                showStatus('Searching…', 'loading');
                run(q);
            });
            input.addEventListener('keydown', (e) => {
                if (menu.hidden) return;
                if (e.key === 'Escape') { close(); return; }
                if (!items.length) return; // a status row is showing — nothing to navigate
                if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); paint(); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
                else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
            });
            document.addEventListener('click', (e) => { if (!host.contains(e.target)) close(); });
        }
    },

};
