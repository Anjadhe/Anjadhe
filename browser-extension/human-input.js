'use strict';
/* The shield (2026-09-21). Runs at document start in every frame of every
 * page in the agent's Chrome profile.
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
 * opens just before it dispatches one. This script never reads a key value, a
 * field or any page text; it sends one bare signal: take-control.
 */
if (!globalThis.__anjadheShield) {
    globalThis.__anjadheShield = true;
    let agent = false, agentUntil = 0, pill = null;
    const top = window === window.top;
    const draw = () => {
        if (!top) return;
        if (!agent) { pill?.remove(); pill = null; return; }
        if (pill?.isConnected) return;
        if (!document.documentElement) { document.addEventListener('DOMContentLoaded', draw, { once: true }); return; }
        pill = document.createElement('div');
        pill.setAttribute('data-anjadhe-shield', '');
        pill.style.cssText = 'all:initial;position:fixed!important;left:50%!important;bottom:18px!important;transform:translateX(-50%)!important;z-index:2147483647!important;display:flex!important;align-items:center!important;gap:12px!important;padding:7px 8px 7px 16px!important;border-radius:999px!important;background:#171717!important;color:#f5f5f3!important;font:400 13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif!important;box-shadow:0 1px 2px rgba(0,0,0,.2),0 10px 30px -12px rgba(0,0,0,.5)!important;transition:transform 300ms!important;';
        const text = document.createElement('span');
        text.textContent = 'nenva is working here';
        text.style.cssText = 'all:initial;color:inherit;font:inherit;';
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = 'Take control';
        button.style.cssText = 'all:initial;cursor:pointer;padding:5px 13px;border-radius:999px;background:#f5f5f3;color:#171717;font:600 13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;';
        button.addEventListener('click', event => { if (event.isTrusted) chrome.runtime.sendMessage({ kind: 'take-control' }).catch(() => {}); });
        pill.append(text, button);
        document.documentElement.appendChild(pill);
    };
    const nudge = () => {
        if (!pill) return;
        pill.style.setProperty('transform', 'translateX(-50%) scale(1.06)', 'important');
        setTimeout(() => pill?.style.setProperty('transform', 'translateX(-50%)', 'important'), 260);
    };
    const apply = mode => { agent = !!(mode && mode.agent); draw(); };
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
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.kind === 'mode') { apply(message); respond({ ok: true }); }
        else if (message?.kind === 'agent-input') { agentUntil = Date.now() + Math.min(2000, Number(message.ms) || 700); respond({ ok: true }); }
    });
    chrome.runtime.sendMessage({ kind: 'mode?' }).then(apply).catch(() => {});
}
