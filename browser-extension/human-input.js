'use strict';
/* The shield (2026-09-21), and the recorder (2026-10-07). Runs at document
 * start in every frame of every page in the agent's Chrome profile.
 *
 * LOOKING is not taking over; PRESSING is. Focusing the agent's window — and
 * the click that raises it — leaves the team working. A trusted click or key
 * meant for the page hands the wheel over: the press itself is swallowed (it
 * must not reach the page behind the agent's back) and the team pauses, so
 * the next click is the user's own. The worker decides which kind of press it
 * was, because only it sees the window gain focus; this script reports a bare
 * press and swallows it either way.
 *
 * The agent's own trusted events are told apart by a short window the worker
 * opens just before it dispatches one. In shield mode this script never reads
 * a key value, a field or any page text; it sends one bare signal:
 * take-control.
 *
 * ── Recording (docs/TEACH.md) ─────────────────────────────────────────────
 * While the person is SHOWING nenva a task ("let me show you"), the worker
 * puts this script in recording mode: nothing is swallowed, the pill says
 * nenva is watching, and each thing the person does is reported as ONE
 * semantic event — what they clicked, chose or typed, by the control's
 * label, the way `look` names controls for the agent. Never coordinates,
 * never keystrokes. A field only the person may fill (the worker hands over
 * the same MANUAL_FIELDS selector `look` masks) is reported as filled, with
 * no value: a password, a code or a card number never enters a recording.
 * The person ends it with Done in the pill or by telling nenva.
 */
if (!globalThis.__anjadheShield) {
    globalThis.__anjadheShield = true;
    let agent = false, recording = false, manualFields = '', agentUntil = 0, pill = null;
    const top = window === window.top;
    const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif';
    const draw = () => {
        if (!top) return;
        if (!agent && !recording) { pill?.remove(); pill = null; return; }
        if (pill?.isConnected && pill.dataset.mode === (agent ? 'agent' : 'recording')) return;
        if (!document.documentElement) { document.addEventListener('DOMContentLoaded', draw, { once: true }); return; }
        pill?.remove();
        pill = document.createElement('div');
        pill.setAttribute('data-anjadhe-shield', '');
        pill.dataset.mode = agent ? 'agent' : 'recording';
        pill.style.cssText = `all:initial;position:fixed!important;left:50%!important;bottom:18px!important;transform:translateX(-50%)!important;z-index:2147483647!important;display:flex!important;align-items:center!important;gap:12px!important;padding:7px 8px 7px 16px!important;border-radius:999px!important;background:#171717!important;color:#f5f5f3!important;font:400 13px/1.3 ${FONT}!important;box-shadow:0 1px 2px rgba(0,0,0,.2),0 10px 30px -12px rgba(0,0,0,.5)!important;transition:transform 300ms!important;`;
        const text = document.createElement('span');
        text.textContent = agent ? 'nenva is working here' : 'nenva is watching how you do this';
        text.style.cssText = 'all:initial;color:inherit;font:inherit;';
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = agent ? 'Take control' : 'Done';
        button.style.cssText = `all:initial;cursor:pointer;padding:5px 13px;border-radius:999px;background:#f5f5f3;color:#171717;font:600 13px/1.3 ${FONT};`;
        button.addEventListener('click', event => {
            if (!event.isTrusted) return;
            chrome.runtime.sendMessage({ kind: agent ? 'take-control' : 'record-done' }).catch(() => {});
        });
        pill.append(text, button);
        document.documentElement.appendChild(pill);
    };
    const nudge = () => {
        if (!pill) return;
        pill.style.setProperty('transform', 'translateX(-50%) scale(1.06)', 'important');
        setTimeout(() => pill?.style.setProperty('transform', 'translateX(-50%)', 'important'), 260);
    };
    const apply = mode => {
        agent = !!(mode && mode.agent);
        recording = !agent && !!(mode && mode.recording);
        if (mode && typeof mode.manualFields === 'string') manualFields = mode.manualFields;
        draw();
    };
    const handOver = press => {
        chrome.runtime.sendMessage({ kind: 'take-control', press })
            .then(answer => { if (answer && answer.activation) nudge(); })
            .catch(() => {});
    };
    const gate = event => {
        if (!agent || !event.isTrusted || Date.now() < agentUntil) return;
        if (event.target && event.target.closest && event.target.closest('[data-anjadhe-shield]')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.type === 'pointerdown') handOver('pointer');
        else if (event.type === 'keydown') handOver('key');
    };
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'keydown', 'keypress', 'keyup']) {
        window.addEventListener(type, gate, true);
    }

    /* ── The recorder ──────────────────────────────────────────────────── */
    const clean = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const CONTROL = 'a[href],button,input,textarea,select,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[onclick],[tabindex]';
    // The same reading `look` gives a control, so the write-up and the
    // replay name things alike.
    const labelOf = el => {
        try {
            return clean(el.getAttribute('aria-label')
                || (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.textContent || '').join(' ').trim()
                || el.labels?.[0]?.innerText || (el.matches('input[type="submit"],input[type="button"]') ? el.value : '')
                || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt')
                || el.querySelector?.('img[alt]')?.getAttribute('alt') || el.querySelector?.('svg title')?.textContent || el.getAttribute('name') || '', 90);
        } catch { return ''; }
    };
    const nearOf = el => {
        for (let parent = el.parentElement, depth = 0; parent && depth < 7; parent = parent.parentElement, depth++) {
            const heading = parent.querySelector?.('h1,h2,h3,h4,h5,h6,legend,[role="heading"]');
            if (heading && !heading.contains(el)) { const text = clean(heading.innerText, 70); if (text) return text; }
        }
        return '';
    };
    const roleOf = el => el.getAttribute('role') || (el.isContentEditable ? 'textbox' : el.tagName.toLowerCase());
    const secure = el => { try { return !!manualFields && el.matches(manualFields); } catch { return false; } };
    const hrefOf = el => {
        if (el.tagName !== 'A' || !/^https?:/.test(el.href)) return undefined;
        try { const url = new URL(el.href); return (url.origin + url.pathname).slice(0, 200); } catch { return undefined; }
    };
    const report = event => {
        if (!recording) return;
        chrome.runtime.sendMessage({ kind: 'recorded', event }).catch(() => {});
    };
    const describe = (el, extra = {}) => {
        const near = nearOf(el);
        return { role: roleOf(el), label: labelOf(el), ...(near ? { near } : {}), ...extra };
    };
    const onClick = event => {
        if (!recording || !event.isTrusted) return;
        const target = event.target;
        if (!target || !target.closest || target.closest('[data-anjadhe-shield]')) return;
        const el = target.closest(CONTROL) || target;
        // A checkbox, radio or field reports on change, where the OUTCOME is known.
        if (el.matches('input:not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),textarea,select')) return;
        if (el.tagName === 'LABEL' && el.control && el.control.matches('input,select,textarea')) return;
        if (!(el.matches(CONTROL) || el.isContentEditable || (el.innerText && clean(el.innerText, 90)))) return;
        report({ type: 'click', ...describe(el, { href: hrefOf(el) }) });
    };
    const onChange = event => {
        if (!recording || !event.isTrusted) return;
        const el = event.target;
        if (!el || !el.matches || el.closest('[data-anjadhe-shield]')) return;
        if (el.tagName === 'SELECT') { report({ type: 'choose', ...describe(el, { value: clean(el.selectedOptions?.[0]?.text, 80) }) }); return; }
        if (el.matches('input[type="checkbox"],input[type="radio"]')) { report({ type: 'toggle', ...describe(el, { checked: !!el.checked }) }); return; }
        if (el.matches('input[type="file"]')) { report({ type: 'file', ...describe(el) }); return; }
        if (el.matches('input,textarea')) {
            const hidden = secure(el);
            report({ type: 'type', ...describe(el), ...(hidden ? { secure: true } : { value: clean(el.value, 200) }) });
        }
    };
    const onKey = event => {
        if (!recording || !event.isTrusted || event.key !== 'Enter') return;
        let el = event.target;
        if (!el || !el.matches || el.closest('[data-anjadhe-shield]')) return;
        if (el.matches('textarea') && !(event.metaKey || event.ctrlKey)) return; // a new line, not a submit
        if (el.matches('input,textarea') || el.isContentEditable) {
            // The value is known at Enter even without a change event yet.
            if (el.matches('input') && !secure(el) && el.value) report({ type: 'type', ...describe(el, { value: clean(el.value, 200) }) });
            else if (el.matches('input') && secure(el)) report({ type: 'type', ...describe(el, { secure: true }) });
            report({ type: 'press', key: 'Enter', ...describe(el) });
        }
    };
    window.addEventListener('click', onClick, true);
    window.addEventListener('change', onChange, true);
    window.addEventListener('keydown', onKey, true);

    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.kind === 'mode') { apply(message); respond({ ok: true }); }
        else if (message?.kind === 'agent-input') { agentUntil = Date.now() + Math.min(2000, Number(message.ms) || 700); respond({ ok: true }); }
    });
    chrome.runtime.sendMessage({ kind: 'mode?' }).then(apply).catch(() => {});
}
