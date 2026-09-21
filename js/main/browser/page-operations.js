'use strict';
// Fixed operations shared by the Electron guest and Chrome extension.
//
// MANUAL_FIELDS is the ONE definition of a field only the user may fill:
// sign-in details, one-time codes and payment details. It is passed INTO
// each operation because both runtimes serialize these functions on their
// own (Electron's executeJavaScriptInIsolatedWorld, Chrome's
// scripting.executeScript func/args), so a module-scope constant would be
// out of scope inside them and silently read as undefined. Every call site
// passes MANUAL_FIELDS; there is no default, so a missed one fails loudly
// instead of quietly unmasking a card number.
//
// Payment fields joined the set on 2026-09-20 with the checkout rule: the
// agent may drive a purchase up to its confirm button, and the user enters
// the card. That promise is kept HERE, in code, not in a prompt — typing
// into one of these is refused, its value never enters a snapshot, and it
// is masked out of every screenshot.
const MANUAL_FIELDS = [
    'input[type="password"]', 'input[autocomplete*="password"]',
    'input[autocomplete="one-time-code"]', 'input[autocomplete="username"]',
    'input[type="email"]',
    'input[autocomplete^="cc-"]',
    'input[name*="cardnum" i]', 'input[name*="card-number" i]', 'input[name*="creditcard" i]',
    'input[name*="cvc" i]', 'input[name*="cvv" i]', 'input[name*="securitycode" i]',
    'input[name*="security-code" i]', 'input[name*="cardcode" i]', 'input[name*="accountnumber" i]',
    'input[id*="cardnum" i]', 'input[id*="creditcard" i]', 'input[id*="cvc" i]', 'input[id*="cvv" i]',
    'input[aria-label*="card number" i]', 'input[aria-label*="security code" i]',
    'input[placeholder*="card number" i]', 'input[placeholder*="security code" i]'
].join(',');
/* ── look: what a person would see, numbered (2026-09-21) ───────────────
 *
 * ONE observation shape, the same contract as screen_look and mac_look:
 * the controls IN THE VIEWPORT, numbered in reading order, plus the text in
 * the viewport and where the viewport sits on the page. It replaced a
 * whole-page snapshot (10k characters of text and up to 14 KB of control
 * rows), which filled a small model's context in one read and then needed a
 * `find` argument, a truncation rule and a screenshot alternation to work
 * around its own size. A page is read the way a person reads it: look,
 * scroll or find, look again.
 *
 * Nothing here knows what a page is ABOUT. There is no vocabulary for
 * cinemas, seats, dates or shops; site know-how lives in playbooks
 * (js/agent/specialists/playbooks.js), which are notes for the model, never
 * branches in this file.
 */
function look(epoch, options = {}, manualFields = '') {
    const MAX_ROWS = 80, MAX_TEXT = 2500;
    // Every root a page script can reach: the document, open shadow roots
    // and same-origin frames. Consent widgets and embedded checkouts live in
    // these. Written out here and in dismissConsent because both runtimes
    // serialize each function on its own (see MANUAL_FIELDS above).
    const roots = (() => {
        const found = [document];
        const walk = (root, depth) => {
            if (depth > 4 || found.length > 30) return;
            let all = [];
            try { all = [...root.querySelectorAll('*')]; } catch { return; }
            for (const el of all) {
                if (found.length > 30) return;
                if (el.shadowRoot) { found.push(el.shadowRoot); walk(el.shadowRoot, depth + 1); }
                if (el.tagName === 'IFRAME') {
                    let doc = null;
                    try { doc = el.contentDocument; } catch { doc = null; } // Cross-origin.
                    if (doc && doc.body) { found.push(doc); walk(doc, depth + 1); }
                }
            }
        };
        walk(document, 0);
        return found;
    })();
    const queryAll = selector => {
        const out = [];
        for (const root of roots) { try { out.push(...root.querySelectorAll(selector)); } catch { /* detached */ } }
        return out;
    };
    // A rect in TOP-WINDOW viewport coordinates, through same-origin frames.
    const rectOf = el => {
        let r = el.getBoundingClientRect(), x = r.left, y = r.top, win = el.ownerDocument.defaultView;
        try {
            while (win && win !== window && win.frameElement) {
                const fr = win.frameElement.getBoundingClientRect();
                x += fr.left; y += fr.top; win = win.parent;
            }
        } catch { /* cross-origin parent: keep what we have */ }
        return { x, y, w: r.width, h: r.height };
    };
    const visible = el => {
        try {
            if (!el.getClientRects().length || el.closest('[aria-hidden="true"]')) return false;
            const style = getComputedStyle(el);
            return style.visibility !== 'hidden' && style.opacity !== '0';
        } catch { return false; }
    };
    const onScreen = r => r.w > 0 && r.h > 0 && r.y + r.h > 0 && r.y < innerHeight && r.x + r.w > 0 && r.x < innerWidth;
    const clean = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const label = el => clean(el.getAttribute('aria-label')
        || (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.textContent || '').join(' ').trim()
        || el.labels?.[0]?.innerText || (el.matches('input[type="submit"],input[type="button"]') ? el.value : '')
        || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt')
        || el.querySelector?.('img[alt]')?.getAttribute('alt') || el.querySelector?.('svg title')?.textContent || el.getAttribute('name') || '', 90);

    // A human-verification wall is reported, never worked around.
    const challenge = [...document.querySelectorAll('iframe')].some(frame => {
        const r = frame.getBoundingClientRect();
        return visible(frame) && r.width >= 100 && r.height >= 30
            && /challenges\.cloudflare\.com|(?:google\.com|recaptcha\.net)\/recaptcha|hcaptcha\.com|security challenge|verify (?:you are )?human/i.test(`${frame.src} ${frame.title}`);
    });

    // An open dialog owns the page: a person cannot use what is behind it.
    const dialogs = queryAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],.dialog[aria-hidden="false"]')
        .filter(visible).filter(el => onScreen(rectOf(el))).slice(-2);
    const inDialog = el => !dialogs.length || dialogs.some(dialog => dialog.contains(el));

    const SELECTOR = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[contenteditable="true"],[contenteditable=""],[onclick],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="option"],[role="menuitem"],[role="combobox"],[role="searchbox"],[role="textbox"],[tabindex]:not([tabindex="-1"])';
    // The extension's own "Anjadhe is working here" pill is not part of the page.
    const all = queryAll(SELECTOR).filter(el => visible(el) && inDialog(el) && !el.closest('[data-anjadhe-shield]'));
    let above = 0, below = 0;
    const shown = [];
    for (const el of all) {
        const r = rectOf(el);
        if (r.w < 2 || r.h < 2) continue;
        if (r.y + r.h <= 0) { above++; continue; }
        if (r.y >= innerHeight) { below++; continue; }
        if (!onScreen(r)) continue;
        shown.push({ el, r });
    }
    // Nested clickables (a card link wrapping a button) both list; a wrapper
    // whose label merely repeats its only listed child is dropped.
    const kept = shown.filter(({ el }) => !shown.some(other => other.el !== el && el.contains(other.el) && label(other.el) === label(el)));
    // Reading order: rows of roughly a line's height, left to right.
    kept.sort((a, b) => (Math.round(a.r.y / 14) - Math.round(b.r.y / 14)) || (a.r.x - b.r.x));

    // The nearest heading, used ONLY to tell identical labels apart.
    const near = el => {
        for (let parent = el.parentElement, depth = 0; parent && depth < 7; parent = parent.parentElement, depth++) {
            const heading = parent.querySelector?.('h1,h2,h3,h4,h5,h6,legend,[role="heading"]');
            if (heading && visible(heading) && !heading.contains(el)) { const text = clean(heading.innerText, 70); if (text) return text; }
        }
        return '';
    };
    const counts = new Map();
    for (const { el } of kept) { const key = label(el); counts.set(key, (counts.get(key) || 0) + 1); }

    const refs = new Map(), rows = [];
    for (const { el, r } of kept) {
        if (rows.length >= MAX_ROWS) break;
        const n = rows.length + 1, text = label(el);
        const secure = !!manualFields && el.matches(manualFields);
        const field = el.matches('input,textarea,select') || el.isContentEditable;
        const form = el.form || null;
        const submit = form && [...form.querySelectorAll('button:not([type="button"]):not([type="reset"]),input[type="submit"]')].find(visible);
        refs.set(String(n), { el, signature: [el.tagName, clean(el.innerText, 60), el.getAttribute('href')].join('|') });
        rows.push({ n, role: el.getAttribute('role') || (el.isContentEditable ? 'textbox' : el.tagName.toLowerCase()), label: text,
            ...(counts.get(text) > 1 || !text ? (near(el) ? { near: near(el) } : {}) : {}),
            ...(el.disabled || el.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}),
            ...(field && !el.isContentEditable ? { type: el.type || 'text', ...(el.readOnly ? { readOnly: true } : {}),
                ...(el.name ? { name: clean(el.name, 60) } : {}), ...(el.getAttribute('placeholder') ? { placeholder: clean(el.getAttribute('placeholder'), 80) } : {}),
                ...(!secure && el.type !== 'file' && el.tagName !== 'SELECT' && el.value ? { value: clean(el.value, 120) } : {}) } : {}),
            ...(el.tagName === 'SELECT' ? { value: clean(el.selectedOptions?.[0]?.text, 80), options: [...el.options].filter(o => !o.disabled).slice(0, 30).map(o => clean(o.text, 60)) } : {}),
            ...(['checkbox', 'radio'].includes(el.type) || el.hasAttribute('aria-checked') ? { checked: el.checked === true || el.getAttribute('aria-checked') === 'true' } : {}),
            ...(el.getAttribute('aria-selected') === 'true' || el.hasAttribute('aria-current') ? { selected: true } : {}),
            ...(el.hasAttribute('aria-expanded') ? { expanded: el.getAttribute('aria-expanded') === 'true' } : {}),
            ...(el.tagName === 'A' && /^https?:/.test(el.href) && el.href.length < 600 ? { href: el.href } : {}),
            // What pressing Enter in this field would press. Main reads it
            // for the asks-every-time rule; the model never supplies it.
            ...(field && submit ? { submits: label(submit) } : {}),
            ...(secure ? { manualOnly: true } : {}),
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    }
    globalThis.__anjadheBrowserRefs = { refs, url: location.href, challenge, epoch };

    // The words in the viewport, in document order.
    const scope = dialogs.length ? dialogs : [document.body].filter(Boolean);
    let text = '', visited = 0;
    for (const root of scope) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let lastBlock = null;
        for (let node = walker.nextNode(); node && text.length < MAX_TEXT && visited < 6000; node = walker.nextNode()) {
            visited++;
            const value = node.nodeValue.replace(/\s+/g, ' ');
            if (!value.trim()) continue;
            const parent = node.parentElement;
            if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) || !visible(parent) || parent.closest('[data-anjadhe-shield]')) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            const r = range.getBoundingClientRect();
            if (!(r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)) continue;
            const block = parent.closest('p,li,h1,h2,h3,h4,h5,h6,tr,div,section,article,td,th,label,button,a') || parent;
            text += (lastBlock && block !== lastBlock ? '\n' : '') + value;
            lastBlock = block;
        }
    }
    const page = document.scrollingElement || document.documentElement;
    const manualVisible = !!manualFields && queryAll(manualFields).some(el => visible(el) && onScreen(rectOf(el)));
    return { url: location.href.slice(0, 2000), title: document.title.slice(0, 200), checkedAt: new Date().toISOString(), look: epoch,
        ...(challenge ? { blocker: 'This page shows a human-verification challenge. Only the user can complete it: they choose Open browser, take control, finish it, then Continue.' } : {}),
        ...(manualVisible ? { manualFields: 'This page has sign-in, code or payment fields. Only the user can fill those, through Open browser. Everything else on the page is yours.' } : {}),
        ...(dialogs.length ? { dialog: clean(dialogs.at(-1).getAttribute('aria-label') || dialogs.at(-1).querySelector('h1,h2,h3,[role="heading"]')?.innerText || 'A dialog is open', 100) } : {}),
        elements: rows,
        more: { above, below, ...(kept.length > rows.length ? { unlisted: kept.length - rows.length } : {}) },
        scroll: { y: Math.round(page.scrollTop), viewport: innerHeight, height: Math.round(page.scrollHeight) },
        text: text.trim().slice(0, MAX_TEXT),
        readyState: document.readyState };
}

/* ── interact: one step on one numbered control ─────────────────────────
 * `locate` resolves a number to a viewport point and changes nothing, so the
 * extension can press it with a TRUSTED input event; the other actions are
 * the synthetic fallback for when it cannot. Every path checks that the
 * number still names the control the look listed, and that it is not a field
 * only the user may fill. */
function interact(args, manualFields = '') {
    const state = globalThis.__anjadheBrowserRefs;
    if (!state || state.url !== location.href) return { error: 'The page changed since the last look. Use the numbers from a fresh look.' };
    if (state.challenge) return { error: 'Human verification is required. Only the user can do that: they choose Open browser and take control, then Continue.' };
    if (!manualFields) return { error: 'The browser operation is misconfigured and cannot verify manual-entry fields. No action was performed.' };
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    if (args.action === 'scroll') {
        // A dialog usually owns its own scroll area; scrolling the window
        // underneath would change nothing the user can see.
        const dialog = [...document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"],.dialog[aria-hidden="false"]')]
            .filter(el => el.getClientRects().length && !el.closest('[aria-hidden="true"]') && getComputedStyle(el).visibility !== 'hidden').at(-1);
        const area = dialog && [dialog, ...dialog.querySelectorAll('*')].find(el =>
            el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY));
        const target = area || document.scrollingElement || document.documentElement;
        const before = target.scrollTop;
        const amount = (args.direction === 'up' ? -1 : 1) * (area?.clientHeight || innerHeight) * .8;
        if (area) area.scrollBy(0, amount); else window.scrollBy(0, amount);
        return { ok: true, moved: Math.round(target.scrollTop - before) !== 0 };
    }
    if (args.action === 'find') {
        const needle = clean(args.text).toLowerCase();
        if (!needle) return { error: 'find needs the text to look for.' };
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let count = 0, first = null;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.nodeValue.toLowerCase().includes(needle)) continue;
            const parent = node.parentElement;
            if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) || !parent.getClientRects().length) continue;
            count++; first ||= parent;
        }
        if (!first) return { ok: true, found: 0 };
        first.scrollIntoView({ block: 'center' });
        return { ok: true, found: count };
    }
    if (args.action === 'focus-info') {
        // What the keyboard would act on right now. Read before a trusted
        // key or text event, which goes wherever the focus is.
        let el = document.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        const editable = !!el && (el.matches('input,textarea') ? !el.readOnly && !el.disabled : el.isContentEditable);
        return { ok: true, editable, manual: !!el && (el.matches(manualFields) || el.matches('input[type="file"]')) };
    }
    const entry = state.refs.get(String(args.n)), el = entry?.el;
    const labelNow = () => clean(el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').slice(0, 90);
    if (!entry) return { error: `There is no control numbered ${args.n} in the latest look.` };
    if (!el.isConnected || !el.getClientRects().length) return { error: `Control ${args.n} is no longer on the page. Use the numbers from a fresh look.` };
    if (entry.signature !== [el.tagName, clean(el.innerText).slice(0, 60), el.getAttribute('href')].join('|')) return { error: `Control ${args.n} changed since the last look. Use the numbers from a fresh look.` };
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { error: `Control ${args.n} is disabled.` };
    if (el.matches(manualFields) || el.matches('input[type="file"]')) return { error: 'Only the user can fill this field. Stop here and say so: they choose Open browser, take control, enter it themselves, then Continue.', manualRequired: true };
    const target = [el.tagName, el.getAttribute('aria-label'), (el.innerText || '').slice(0, 160), el.getAttribute('href'), el.getAttribute('name')];

    if (args.action === 'locate') {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        let r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, framed = false;
        try {
            for (let win = el.ownerDocument.defaultView; win && win !== window && win.frameElement; win = win.parent) {
                const fr = win.frameElement.getBoundingClientRect(); x += fr.left; y += fr.top; framed = true;
            }
        } catch { framed = true; }
        // Is this control what a pointer at that point would actually hit?
        let hit = false;
        if (!framed && x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight) {
            let top = document.elementFromPoint(x, y);
            while (top && top.shadowRoot) { const inner = top.shadowRoot.elementFromPoint(x, y); if (!inner || inner === top) break; top = inner; }
            hit = !!top && (el.contains(top) || top.contains(el) || (el.labels && [...el.labels].some(l => l.contains(top))));
        }
        return { ok: true, hit, x: Math.round(x), y: Math.round(y), target,
            editable: el.matches('input,textarea') ? !el.readOnly : !!el.isContentEditable, select: el.tagName === 'SELECT' };
    }
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (args.action === 'click') {
        // Custom selects open on mousedown/focus, not on click alone.
        const focus = el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 }));
        if (focus) el.focus();
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0 }));
        el.click();
    } else if (args.action === 'select-text') {
        // Ready a field for a trusted text insertion that REPLACES its value.
        el.focus();
        if (el.matches('input,textarea')) { try { el.select(); } catch { /* type=email etc. cannot select */ } }
        else if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
        return { ok: true, target };
    } else if (args.action === 'type') {
        if (typeof args.text !== 'string' || args.text.length > 4000) return { error: 'type needs text of at most 4000 characters.' };
        if (el.isContentEditable) { el.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, args.text); }
        else {
            if (!el.matches('input,textarea')) return { error: `Control ${args.n} is not a text field.` };
            if (el.readOnly) return { error: 'This field is read-only: it is a picker. Click it, then choose one of the options a fresh look lists.' };
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            el.focus();
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, args.text);
            el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (args.submit) {
            const form = el.form;
            if (form && form.querySelector(`${manualFields},input[type="file"]`)) return { error: 'This form has fields only the user can fill, so it is theirs to submit.', manualRequired: true };
            const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
            const go = el.dispatchEvent(new KeyboardEvent('keydown', init));
            el.dispatchEvent(new KeyboardEvent('keyup', init));
            if (go && form) form.requestSubmit();
        }
    } else if (args.action === 'select') {
        if (el.tagName !== 'SELECT') return { error: `Control ${args.n} is not a dropdown. Click it, then choose from the options a fresh look lists.` };
        const want = clean(args.text).toLowerCase();
        const option = [...el.options].find(o => clean(o.text).toLowerCase() === want || o.value.toLowerCase() === want)
            || [...el.options].find(o => clean(o.text).toLowerCase().includes(want));
        if (!option || !want) return { error: `That dropdown has no option “${args.text}”. Its options: ${[...el.options].slice(0, 30).map(o => clean(o.text)).join(' | ')}` };
        el.value = option.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    } else return { error: 'Unsupported page action.' };
    return { ok: true, target, label: labelNow() };
}

/* The numbers from the latest look, drawn on the page for one screenshot
 * and removed again. Same idea as the masks below: fixed application code,
 * isolated world, always restored. */
function marks(show) {
    for (const el of globalThis.__anjadheMarks || []) el.remove();
    globalThis.__anjadheMarks = [];
    const state = globalThis.__anjadheBrowserRefs;
    if (!show || !state) return { ok: true, drawn: 0 };
    for (const [n, entry] of state.refs) {
        const el = entry.el;
        if (!el?.isConnected) continue;
        let r = el.getBoundingClientRect(), x = r.left, y = r.top;
        try {
            for (let win = el.ownerDocument.defaultView; win && win !== window && win.frameElement; win = win.parent) {
                const fr = win.frameElement.getBoundingClientRect(); x += fr.left; y += fr.top;
            }
        } catch { continue; }
        if (!r.width || !r.height) continue;
        const tag = document.createElement('div');
        tag.textContent = n;
        tag.style.cssText = `position:fixed!important;left:${Math.max(0, x - 2)}px!important;top:${Math.max(0, y - 2)}px!important;background:#e6007a!important;color:#fff!important;font:700 11px/14px -apple-system,Helvetica,Arial,sans-serif!important;padding:0 3px!important;border-radius:3px!important;z-index:2147483647!important;pointer-events:none!important;box-shadow:0 0 0 1px #fff!important;`;
        document.documentElement.appendChild(tag); globalThis.__anjadheMarks.push(tag);
    }
    return { ok: true, drawn: globalThis.__anjadheMarks.length };
}


// Fixed application code in the browser's isolated world. Never reads field
// values. Restore even after capture failure; never synthesize user input.
function screenshotMask(show, manualFields = '') {
    for (const el of globalThis.__anjadheScreenshotMasks || []) el.remove();
    globalThis.__anjadheScreenshotMasks = [];
    // The agent's picture is of the PAGE: the extension's own pill is hidden for it.
    for (const el of document.querySelectorAll('[data-anjadhe-shield]')) el.style.setProperty('visibility', show ? 'hidden' : 'visible', 'important');
    if (show) for (const el of (manualFields ? document.querySelectorAll(manualFields) : [])) {
        const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
        const mask = document.createElement('div');
        mask.style.cssText = `position:fixed!important;left:${r.left}px!important;top:${r.top}px!important;width:${r.width}px!important;height:${r.height}px!important;background:#777!important;z-index:2147483647!important;pointer-events:none!important;`;
        document.documentElement.appendChild(mask); globalThis.__anjadheScreenshotMasks.push(mask);
    }
    return { url: location.href, width: innerWidth, height: innerHeight, x: scrollX, y: scrollY, epoch: globalThis.__anjadheBrowserRefs?.epoch };
}
/* Close a cookie / privacy-consent dialog, choosing the STRICTEST option
 * the widget offers (2026-09-20, Ram: "it should always choose to use
 * stringent options like disabling targeting or marketing cookies").
 *
 * The APP picks the button, not the model. That is the whole point: a model
 * reading a page that says "Accept all to continue" is exactly the thing a
 * consent wall is designed to talk into clicking, and page text is untrusted
 * input. So the choice here is vocabulary over the rendered label, in a
 * fixed order of preference, and ACCEPT IS NOT IN THE VOCABULARY. There is
 * no argument that selects a button and no way for a caller to reach one.
 *
 * Order, strictest first:
 *   1. Reject / decline / refuse everything.
 *   2. Necessary or essential only, or "continue without accepting".
 *   3. Open the preferences panel, turn every non-essential category OFF,
 *      and save. This is the branch that actually disables targeting and
 *      marketing cookies when the banner has no one-click reject.
 *   4. Acknowledge a banner that offers NO choice at all ("Got it"), which
 *      grants nothing that reading the page already did. Reported as
 *      `acknowledged`, never as `rejected`, because they are not the same
 *      claim and the report must not overstate it.
 *
 * Returns what it did and what it pressed, so the caller can say so
 * honestly rather than assuming a banner is gone.
 */
function dismissConsent(target) {
    const roots = (() => {
        const found = [document];
        const walk = (root, depth) => {
            if (depth > 4 || found.length > 30) return;
            let all = [];
            try { all = [...root.querySelectorAll('*')]; } catch { return; }
            for (const el of all) {
                if (found.length > 30) return;
                if (el.shadowRoot) { found.push(el.shadowRoot); walk(el.shadowRoot, depth + 1); }
                if (el.tagName === 'IFRAME') {
                    let doc = null;
                    try { doc = el.contentDocument; } catch { doc = null; }
                    if (doc && doc.body) { found.push(doc); walk(doc, depth + 1); }
                }
            }
        };
        walk(document, 0);
        return found;
    })();
    const queryAll = selector => {
        const out = [];
        for (const root of roots) { try { out.push(...root.querySelectorAll(selector)); } catch { /* detached */ } }
        return out;
    };
    const visible = el => {
        try {
            const style = getComputedStyle(el);
            return !!el.getClientRects().length && style.visibility !== 'hidden' && style.opacity !== '0';
        } catch { return false; }
    };
    const labelOf = el => (el.getAttribute('aria-label') || el.value || el.innerText || el.textContent || '')
        .replace(/\s+/g, ' ').trim().slice(0, 120);

    // Vocabulary. Never "accept", "allow all", "agree", "consent to".
    const REJECT_ALL = /\b(reject|decline|refuse|deny|disagree)\b.{0,20}\b(all|cookies|everything|non[- ]?essential|optional)\b|\b(reject|decline|refuse|deny)\s+all\b/i;
    const NECESSARY_ONLY = /\b(only|just)\b.{0,16}\b(necessary|essential|required|functional)\b|\b(strictly\s+)?(necessary|essential|required)\b.{0,16}\b(only|cookies only)\b|\bcontinue without (accepting|agreeing)\b|\buse necessary cookies only\b/i;
    const MANAGE = /\b(manage|customi[sz]e|configure|adjust|more options|preferences|settings|choices|let me choose|options)\b/i;
    const SAVE = /\b(save|confirm|submit|apply)\b.{0,20}\b(choices|preferences|settings|selection|options)\b|\b(save|confirm)\b.{0,6}(and (close|exit))?$/i;
    const ACKNOWLEDGE = /^(ok(ay)?|got it|understood|close|dismiss|continue|x)$/i;
    // Categories a widget is allowed to keep on: the ones a site cannot work
    // without. Everything else — targeting, advertising, marketing, social,
    // analytics, personalisation — is switched off.
    const ESSENTIAL = /\b(strictly necessary|necessary|essential|required|mandatory|always (on|active)|security|authentication)\b/i;

    const CONSENT_HINT = /\b(cookie|cookies|consent|privacy|gdpr|ccpa|tracking|your data|data protection|we value your privacy|vendors|legitimate interest)\b/i;
    /* A label that reads as ACCEPTING. Only ever used to REFUSE: the app
     * cannot reliably find every consent widget (there are thousands of
     * bespoke ones), so the model's eyes choose the control \u2014 but a control
     * whose own label says accept is never pressed, whoever asked for it.
     * A short multilingual set, because a German or French banner is not an
     * exotic case; it is not, and does not pretend to be, complete. */
    const ACCEPT = /\b(accept|allow|agree|consent|enable|opt[- ]?in|akzeptier\w*|zustimmen|einverstanden|accepter|aceptar|acepto|accetta|aceitar|accepteren|akkoord|godk\u00e4nn|godtag|zaakceptuj|souhlas|elfogad)\b|\u540c\u610f|\u3059\u3079\u3066\u8a31\u53ef/i;
    const REJECT_WORDS = /\b(ablehnen|refuser|rechazar|rifiuta|recusar|weigeren|neka|odm\u00edtnout)\b|\u62d2\u7d76|\u3059\u3079\u3066\u62d2\u5426/i;
    /* A consent dialog contains none of these. If one is under the point the
     * model named, it is not looking at a consent dialog, and this tool is
     * not the way to press it (W24 owns those steps). */
    const OFF_LIMITS = /\b(buy|purchase|pay|checkout|place (your |my |the )?order|confirm (your |my |the )?(order|purchase|payment)|sign ?in|log ?in|sign ?up|delete|send|subscribe|donate|reserve|book now)\b/i;

    /* \u2500\u2500 The model's eyes choose the control (2026-09-20, Ram: "code based
     * identification wont work. it should be AI based using the vision") \u2500\u2500
     *
     * The app's own detection below still runs first when no target is
     * given, because it is free and correct on the common platforms. But it
     * cannot find every bespoke consent widget, and a banner it cannot find
     * is a banner the agent cannot get past. So Browser may look at a
     * screenshot and name the control it judges most private, by reference
     * or by viewport point, and this resolves and CHECKS it.
     *
     * What the app keeps is the veto, not the choice: a label that reads as
     * accepting is refused however it was named, and so is anything that
     * belongs to W24 (buying, paying, signing in) \u2014 a consent dialog
     * contains none of those, so a point over one means the model is not
     * looking at what it thinks it is. A label nobody can read (a
     * cross-origin frame) is pressed but reported as unverified, never as a
     * rejection, because those are different claims.
     */
    if (target && (target.ref || (Number.isFinite(target.x) && Number.isFinite(target.y)))) {
        let el = null;
        if (target.ref) {
            const store = globalThis.__anjadheBrowserRefs;
            const entry = store && store.refs ? store.refs.get(String(target.ref)) : null;
            el = entry ? entry.el : null;
            if (!el || !el.isConnected) {
                return { ok: false, outcome: 'stale', url: location.href,
                    reason: 'That reference is from an older observation. Look again and name the control by its new number.' };
            }
        } else {
            const x = Math.round(target.x), y = Math.round(target.y);
            if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
                return { ok: false, outcome: 'off-screen', url: location.href,
                    reason: 'That point is outside the captured viewport. Use coordinates from the latest screenshot.' };
            }
            // Down through open shadow roots and same-origin frames, which is
            // where these widgets live and why the page could not list them.
            let node = document.elementFromPoint(x, y), fx = x, fy = y, hops = 0;
            while (node && hops++ < 8) {
                if (node.shadowRoot) {
                    const inner = node.shadowRoot.elementFromPoint(fx, fy);
                    if (inner && inner !== node) { node = inner; continue; }
                }
                if (node.tagName === 'IFRAME') {
                    let doc = null;
                    try { doc = node.contentDocument; } catch { doc = null; } // Cross-origin: unreadable.
                    if (!doc) break;
                    const rect = node.getBoundingClientRect();
                    const inner = doc.elementFromPoint(fx - rect.left, fy - rect.top);
                    if (!inner) break;
                    fx -= rect.left; fy -= rect.top; node = inner; continue;
                }
                break;
            }
            el = node;
        }
        if (!el) {
            return { ok: false, outcome: 'nothing-there', url: location.href,
                reason: 'Nothing is at that point. Look again and name the control by its new number.' };
        }
        if (el.closest && el.closest('[data-anjadhe-shield]')) return { ok: false, outcome: 'refused', url: location.href, reason: 'That is Anjadhe\u2019s own notice, not part of the page. Nothing was clicked.' };
        const clickable = (el.closest && el.closest('button,a,[role="button"],input[type="submit"],input[type="button"],label,[tabindex],[onclick]')) || el;
        const text = labelOf(clickable);
        if (OFF_LIMITS.test(text)) {
            return { ok: false, outcome: 'refused', label: text, url: location.href,
                reason: `\u201c${text}\u201d is not part of a cookie or privacy dialog \u2014 it reads as buying, signing in or sending. Nothing was clicked. Look again.` };
        }
        const strict = REJECT_ALL.test(text) || NECESSARY_ONLY.test(text) || REJECT_WORDS.test(text);
        if (!strict && ACCEPT.test(text)) {
            return { ok: false, outcome: 'refused', label: text, url: location.href,
                reason: `\u201c${text}\u201d accepts cookies, and this tool never accepts on the user\u2019s behalf. Look for reject, decline, "only necessary", or a manage/preferences control and name that instead.` };
        }
        clickable.click();
        const outcome = strict ? ((REJECT_ALL.test(text) || REJECT_WORDS.test(text)) ? 'rejected' : 'necessary-only')
            : MANAGE.test(text) ? 'opened-preferences'
            : text ? 'clicked-unverified' : 'clicked-unreadable';
        return { ok: true, outcome, label: text, chosenBy: 'vision', url: location.href,
            ...(outcome === 'opened-preferences' ? { next: 'The preferences panel should be open. Call dismiss_consent with no arguments to switch every non-essential category off and save.' } : {}),
            ...(outcome === 'clicked-unverified' ? { note: `Pressed \u201c${text}\u201d, which is neither a recognised reject nor an accept. Report it as pressed, not as a rejection.` } : {}),
            ...(outcome === 'clicked-unreadable' ? { note: 'The control carries no readable label (it is inside a cross-origin frame), so what it chose cannot be verified. Take a screenshot and check what the page shows now.' } : {}) };
    }

    // The widget: a known consent container, else a visible dialog or fixed
    // overlay whose own text talks about cookies/consent.
    const KNOWN = '#onetrust-banner-sdk,#onetrust-consent-sdk,#onetrust-pc-sdk,#CybotCookiebotDialog,#didomi-host,#didomi-notice,#usercentrics-root,#uc-center-container,.qc-cmp2-container,.qc-cmp-cleanslate,#cmpbox,.cmp-root,#truste-consent-track,.truste_box_overlay,.osano-cm-window,.cky-consent-container,#cookiescript_injected,#gdpr-consent-tool-wrapper,#sp_message_container_1,[id^="sp_message_container"],#klaro,.cc-window,#cookie-law-info-bar,[aria-label*="cookie" i][role="dialog"],[aria-label*="consent" i][role="dialog"],[aria-label*="privacy" i][role="dialog"]';
    const candidates = [];
    for (const el of queryAll(KNOWN)) if (visible(el)) candidates.push(el);
    if (!candidates.length) {
        for (const el of queryAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]')) {
            if (!visible(el)) continue;
            const text = (el.innerText || '').slice(0, 1200);
            if (CONSENT_HINT.test(text)) candidates.push(el);
        }
    }
    if (!candidates.length) {
        // A bare fixed/sticky bar, which is what most banners actually are.
        for (const el of queryAll('div,section,aside,form')) {
            if (candidates.length >= 3 || !visible(el)) continue;
            let position = '';
            try { position = getComputedStyle(el).position; } catch { continue; }
            if (position !== 'fixed' && position !== 'sticky') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 200 || rect.height < 40) continue;
            const text = (el.innerText || '');
            if (text.length > 4000 || !CONSENT_HINT.test(text.slice(0, 1200))) continue;
            if (!el.querySelector('button,a,[role="button"],input[type="submit"]')) continue;
            candidates.push(el);
        }
    }
    if (!candidates.length) {
        const blockers = queryAll('iframe').filter(frame => {
            if (!visible(frame)) return false;
            let reachable = false;
            try { reachable = !!frame.contentDocument; } catch { reachable = false; }
            const rect = frame.getBoundingClientRect();
            return !reachable && rect.width >= 200 && rect.height >= 60
                && /consent|privacy|cookie|gdpr|truste|sourcepoint|cmp/i.test(`${frame.src} ${frame.title} ${frame.id} ${frame.name}`);
        });
        if (blockers.length) {
            return { ok: false, outcome: 'unreachable', url: location.href,
                reason: 'A consent dialog is rendered inside a cross-origin frame, so its controls cannot be listed. Take a screenshot, find the most private option in the image, and call dismiss_consent again with its viewport x and y.' };
        }
        return { ok: false, outcome: 'none', url: location.href,
            reason: 'No cookie or privacy consent dialog was recognised on this page. If a screenshot shows one anyway, find the most private option in the image and call dismiss_consent again with its viewport x and y, or the reference of that control.' };
    }

    const widget = candidates[0];
    const actions = () => [...widget.querySelectorAll('button,a,[role="button"],input[type="submit"],input[type="button"]')]
        .filter(visible).map(el => ({ el, text: labelOf(el) })).filter(item => item.text);
    const pressed = [];
    const press = item => { pressed.push(item.text); item.el.click(); };
    const pick = (items, rx) => items.find(item => rx.test(item.text));

    let items = actions();
    let choice = pick(items, REJECT_ALL);
    if (choice) { press(choice); return { ok: true, outcome: 'rejected', clicked: pressed, url: location.href }; }
    choice = pick(items, NECESSARY_ONLY);
    if (choice) { press(choice); return { ok: true, outcome: 'necessary-only', clicked: pressed, url: location.href }; }

    // No one-click reject: open preferences and switch the categories off.
    choice = pick(items, MANAGE);
    if (choice) {
        press(choice);
        // The panel may replace the widget, so re-find from the whole page.
        const panelRoots = queryAll(KNOWN + ',dialog[open],[role="dialog"],[aria-modal="true"]').filter(visible);
        const panel = panelRoots.find(el => el.contains(choice.el)) || panelRoots[panelRoots.length - 1] || widget;
        let off = 0, kept = 0;
        const toggles = [...panel.querySelectorAll('input[type="checkbox"],[role="switch"],[role="checkbox"]')].filter(visible);
        for (const toggle of toggles) {
            const context = [toggle.getAttribute('aria-label'), toggle.getAttribute('name'), toggle.id,
                toggle.closest('label') ? toggle.closest('label').innerText : '',
                toggle.parentElement ? toggle.parentElement.innerText : ''].join(' ').slice(0, 300);
            const on = toggle.getAttribute('aria-checked') === 'true' || toggle.checked === true;
            if (toggle.disabled || ESSENTIAL.test(context)) { kept++; continue; }
            if (on) { toggle.click(); off++; }
        }
        const after = [...panel.querySelectorAll('button,a,[role="button"],input[type="submit"]')]
            .filter(visible).map(el => ({ el, text: labelOf(el) })).filter(item => item.text);
        // Prefer an explicit reject that only appears inside the panel.
        const strict = pick(after, REJECT_ALL) || pick(after, NECESSARY_ONLY) || pick(after, SAVE);
        if (strict) { press(strict); return { ok: true, outcome: 'saved-preferences', togglesTurnedOff: off, essentialKept: kept, clicked: pressed, url: location.href }; }
        return { ok: false, outcome: 'panel-open', togglesTurnedOff: off, clicked: pressed, url: location.href,
            reason: 'The preferences panel is open and non-essential categories were switched off, but it offers no recognised save control. Look again and finish from its listed controls.' };
    }

    choice = items.find(item => ACKNOWLEDGE.test(item.text));
    if (choice) { press(choice); return { ok: true, outcome: 'acknowledged', clicked: pressed, url: location.href }; }

    return { ok: false, outcome: 'no-strict-option', url: location.href,
        offered: items.slice(0, 8).map(item => item.text),
        reason: 'No reject, necessary-only or preferences control was recognised here, and this tool never accepts. Take a screenshot: if one of the visible controls is the private choice (in any language), call dismiss_consent again with its viewport x and y. If the only option really is accept, leave it and say so.' };
}

if (typeof module !== 'undefined') module.exports = { look, interact, marks, screenshotMask, dismissConsent, MANUAL_FIELDS };
