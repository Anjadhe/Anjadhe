/* browser_look / browser_act — the workroom browser's two verbs.
 *
 * Workroom-only: no keyword domain, so ordinary chat never receives them,
 * and a call without a live workroom lease is refused here and again in main.
 * Main decides every approval from its own view of the page
 * (js/main/workroom-browser.js); this file only formats what comes back.
 *
 * A look is the controls IN THE VIEWPORT, numbered, plus the words in view
 * and where the viewport sits on the page. An act is ONE step and returns a
 * fresh look. Same contract as screen_look/screen_act and mac_look/mac_act.
 */
const BrowserTools = {
    ACTIONS: ['open', 'click', 'type', 'select', 'press', 'scroll', 'find', 'back', 'wait', 'dismiss_consent'],
    KEYS: ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp'],
    definitions() {
        return [
            { type: 'function', function: { name: 'browser_look',
                description: 'See the page in the workroom browser: its address, the clickable controls currently in view as a NUMBERED list, the words in view, and how far down the page you are. Controls above or below the viewport are counted but not listed; scroll or use find to reach them. When you can view images, a picture of the viewport with the same numbers drawn on it comes too.',
                parameters: { type: 'object', properties: {}, additionalProperties: false } } },
            { type: 'function', function: { name: 'browser_act',
                description: 'Do ONE step in the workroom browser, then get a fresh look back. action: open (url) · click (n) · type (n, text; submit:true also presses Enter) · select (n, text = the option) · press (key) · scroll (direction) · find (text: jumps to that text on the page) · back · wait · dismiss_consent (closes a cookie notice, always refusing; pass n only if it could not find the button itself). n is a number from the LATEST look. Fields marked "user only" (passwords, codes, cards) cannot be typed into.',
                parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
                    action: { type: 'string', enum: this.ACTIONS },
                    n: { type: 'integer', description: 'The control\'s number in the latest look.' },
                    text: { type: 'string', description: 'What to type, the option to select, or the text to find.' },
                    url: { type: 'string', description: 'For open: a full http(s) address.' },
                    key: { type: 'string', enum: this.KEYS },
                    direction: { type: 'string', enum: ['down', 'up'] },
                    submit: { type: 'boolean' } } } } }
        ];
    },
    /** Say what is wrong with the arguments, so the next call fixes itself. */
    checkArgs(args) {
        const allowed = ['action', 'n', 'text', 'url', 'key', 'direction', 'submit'];
        const unknown = Object.keys(args || {}).filter(key => !allowed.includes(key));
        if (unknown.length) return `browser_act does not take ${unknown.map(key => `“${key}”`).join(', ')}. It takes: ${allowed.join(', ')}.`;
        if (!this.ACTIONS.includes(args.action)) return `browser_act needs an action: ${this.ACTIONS.join(', ')}.`;
        const need = { open: ['url'], click: ['n'], type: ['n', 'text'], select: ['n', 'text'], press: ['key'], find: ['text'] }[args.action] || [];
        for (const key of need) if (args[key] === undefined || args[key] === null || args[key] === '') return `browser_act ${args.action} needs “${key}”.`;
        if (args.n !== undefined && !Number.isInteger(Number(args.n))) return 'n must be a number from the latest look.';
        if (args.action === 'press' && !this.KEYS.includes(args.key)) return `press takes one of: ${this.KEYS.join(', ')}.`;
        if (args.action === 'open' && !/^https?:\/\//i.test(String(args.url))) return 'open needs a full address starting with https://';
        return null;
    },
    /** One control as one short line. Tokens are the budget. */
    line(row) {
        const bits = [`[${row.n}]`, row.role];
        if (row.label) bits.push(`“${row.label}”`);
        if (row.near) bits.push(`(under “${row.near}”)`);
        if (row.manualOnly) bits.push('— user only');
        else if (row.type && !['submit', 'button'].includes(row.type)) bits.push(row.value ? `= “${row.value}”` : row.placeholder ? `(${row.placeholder})` : '(empty)');
        if (row.options) bits.push(`options: ${row.options.join(' | ')}`);
        if (row.checked !== undefined) bits.push(row.checked ? '☑' : '☐');
        if (row.selected) bits.push('(selected)');
        if (row.expanded !== undefined) bits.push(row.expanded ? '(open)' : '(closed)');
        if (row.readOnly) bits.push('(picker: click it)');
        if (row.disabled) bits.push('(disabled)');
        if (row.href) { try { const url = new URL(row.href); bits.push(`→ ${url.hostname.replace(/^www\./, '')}${url.pathname.length > 1 ? url.pathname.slice(0, 60) : ''}`); } catch { /* not a URL */ } }
        return bits.join(' ');
    },
    /** A look as the model reads it. */
    format(look, { playbook = '' } = {}) {
        if (!look || typeof look !== 'object') return { error: 'The browser returned nothing.' };
        if (look.error && !Array.isArray(look.elements)) return { error: look.error, ...(look.denied ? { denied: true } : {}), ...(look.cancelled ? { cancelled: true } : {}), waitedMs: look.waitedMs };
        const scroll = look.scroll || {};
        const pages = scroll.viewport ? Math.max(1, Math.ceil(scroll.height / scroll.viewport)) : 1;
        const at = scroll.viewport ? Math.min(pages, Math.floor(scroll.y / scroll.viewport) + 1) : 1;
        const step = look.step || null;
        const out = {
            ...(step?.error ? { stepError: step.error } : {}),
            ...(step?.consent ? { consent: step.consent.outcome + (step.consent.reason ? `: ${step.consent.reason}` : '') } : {}),
            ...(step && step.found !== undefined ? { found: step.found ? `${step.found} match${step.found === 1 ? '' : 'es'}; the first is now in view` : 'That text is not on this page.' } : {}),
            ...(step && step.moved === false ? { note: 'The page did not scroll: you are at the end.' } : {}),
            ...(look.error ? { error: look.error } : {}),
            url: look.url, title: look.title,
            ...(look.blocker ? { blocker: look.blocker } : {}),
            ...(look.manualFields ? { userOnly: look.manualFields } : {}),
            ...(look.dialog ? { dialog: `Open dialog: “${look.dialog}”. Only its controls are listed.` } : {}),
            position: `Screen ${at} of ${pages}. ${look.more?.above || 0} controls above, ${look.more?.below || 0} below${look.more?.unlisted ? `, ${look.more.unlisted} more in view not listed` : ''}.`,
            controls: (look.elements || []).map(row => this.line(row)).join('\n') || '(no controls in view)',
            text: look.text || '',
            ...(look.loading ? { loading: 'The page is still loading. wait, then look.' } : {}),
            ...(playbook ? { notes: playbook } : {}),
            ...(look.images?.length ? { images: look.images } : look.imageError ? { picture: `No picture this time (${look.imageError}). The list above is complete for the viewport.` } : {}),
            waitedMs: look.waitedMs || 0
        };
        return out;
    },
    async ensure() {
        const state = await window.electronAgentBrowser.command('state');
        if (!state.connected && state.supported === false) throw new Error('The workroom browser needs Google Chrome on macOS or Linux.');
        return window.electronAgentBrowser.command('ensure');
    },
    async open({ takeover = false } = {}) {
        if (takeover) await window.electronAgentBrowser.command('takeover');
        return window.electronAgentBrowser.command('show');
    },
    /** ctx.workroom = { id, token, vision, tainted, seen:Set, acted:{step} } */
    async run(action, args, ctx) {
        const room = ctx && ctx.workroom;
        if (!room) return { error: 'Only a Browser agent in a workroom can use this tool.' };
        if (action === 'act') {
            const complaint = this.checkArgs(args);
            if (complaint) return { error: complaint };
            // Numbers belong to ONE look, and every act changes the page.
            if (room.acted && room.acted.step === ctx.step) return { error: 'One step at a time: the page changed after your first step this turn. Read the fresh look, then take the next step.' };
            room.acted = { step: ctx.step };
        }
        try {
            await this.ensure();
            const look = await window.electronAgentBrowser.command('execute', { action, args: action === 'act' ? { ...args, ...(args.n !== undefined ? { n: Number(args.n) } : {}) } : {},
                run: { id: room.id, token: room.token }, image: !!room.vision, tainted: !!room.tainted });
            // What the chat's "is doing" line may name: the labels main just
            // listed, and the site. Never the model's own description of a click.
            if (Array.isArray(look?.elements)) room.labels = new Map(look.elements.map(row => [Number(row.n), row.label || row.placeholder || row.role]));
            if (look?.url) { try { room.host = new URL(look.url).hostname.replace(/^www\./, ''); } catch { /* keep the last one */ } }
            // A site's playbook rides the FIRST look that lands on it.
            let playbook = '';
            if (look?.url && typeof Playbooks !== 'undefined') {
                const fresh = Playbooks.forUrl(look.url).filter(book => !room.seen.has(book.id));
                fresh.forEach(book => room.seen.add(book.id));
                playbook = Playbooks.text(fresh);
            }
            return this.format(look, { playbook });
        } catch (error) { return { error: error.message || String(error) }; }
    },
    init() {
        if (typeof AgentTools === 'undefined') return;
        const [look, act] = this.definitions();
        const opts = { source: 'workroom-browser', group: 'workroom-browser', dataClass: 'browse' };
        AgentTools.register(look, (args, ctx) => this.run('look', {}, ctx), opts);
        AgentTools.register(act, (args, ctx) => this.run('act', args || {}, ctx), opts);
    }
};
if (typeof module !== 'undefined') module.exports = BrowserTools;
else BrowserTools.init();
