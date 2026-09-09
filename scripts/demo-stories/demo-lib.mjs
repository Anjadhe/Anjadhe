// Shared driver for the per-story demo recordings.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const PORT = Number(process.env.DEMO_CDP_PORT || 9333);
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** The download site shown on every closing slide's CTA — the public
 *  domain (anjadhe.ai serves the same site as anjadhe.com; see
 *  docs/POSITIONING.md). Change it HERE, nowhere else. */
export const SITE = 'anjadhe.ai';
/** The standard closing-slide options: app icon, download CTA after the
 *  progress line completes, and the video ENDS on the slide. */
export const CLOSING = { logo: true, cta: SITE, stay: true };

export async function connect() {
    const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
    const page = list.find(t => t.type === 'page');
    if (!page) throw new Error('no page target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== undefined) {
            const p = pending.get(msg.id);
            if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
        } else if (msg.method && listeners.has(msg.method)) listeners.get(msg.method)(msg.params);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const mid = ++id; pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error('eval: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400));
        return r.result?.value;
    };
    return { ws, send, evaluate, on: (m, f) => listeners.set(m, f), close: () => ws.close(), targetId: page.id };
}

export class Demo {
    async init() { this.c = await connect(); return this; }

    E(js) { return this.c.evaluate(`(async () => { ${js} })()`); }

    /** Dismiss chrome, warm prices, make sure a model is selected, reload
     *  clean. A model the user already configured on the instance is KEPT
     *  (a server-based pick must survive the recorder); the Anjadhe Cloud
     *  entry is added only as a fallback when nothing is selected, or
     *  when forced via DEMO_MODEL=cloud|big. */
    async prep() {
        console.log(await this.E(`
            try { AssistantIdentity.dismissNudge(); } catch (e) {}
            try { SetupAssistant.dismiss(); } catch (e) {}
            try { WhatsNew._markSeen(WhatsNew.RELEASES[0].version); const el = document.getElementById('whats-new-chip'); if (el) el.style.display = 'none'; } catch (e) {}
            try { await PortfolioApp.loadData(); await PortfolioApp.refreshPrices(); } catch (e) {}
            const forced = ${JSON.stringify(process.env.DEMO_MODEL || '')};
            if (!forced && AgentService.model) return 'prep ok, keeping configured model: ' + AgentService.model;
            const entry = AgentService.addEntry(${JSON.stringify(
                process.env.DEMO_MODEL === 'big'
                    ? { engine: 'anjadhe', model: 'anjadhe-cloud-qwen3.8', label: 'Qwen3.8-2.4T-A95B' }
                    : { engine: 'anjadhe', model: 'anjadhe-cloud', label: 'DeepSeek-V4-Flash-0731' })});
            await AgentService.setDefaultEntry(entry.id);
            return 'prep ok, ' + (forced ? 'forced' : 'fallback') + ' model: ' + AgentService.model;`));
        await this.c.evaluate('location.reload(); true');
        await sleep(5000);
        this.c.close();
        this.c = await connect();
    }

    /** Wait for ambient analysis + the thread judge to finish. */
    async settleEmail(maxMs = 180000) {
        const t0 = Date.now();
        while (Date.now() - t0 < maxMs) {
            const s = await this.E(`
                await EmailApp.loadData();
                const t = EmailThreads.compute(EmailApp);
                return { a: EmailApp.isAnalyzing || false, p: (EmailApp.pendingAnalysisIds || []).length, j: t.pending };`);
            console.log('settle:', JSON.stringify(s));
            if (!s.a && s.p === 0 && s.j === 0) return;
            await sleep(10000);
        }
        console.warn('settle: timed out, continuing');
    }

    async placeWindow() {
        try {
            const ver = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
            const bws = new WebSocket(ver.webSocketDebuggerUrl);
            await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
            let bid = 0; const bpend = new Map();
            bws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = bpend.get(m.id); if (p) { bpend.delete(m.id); p(m); } };
            const bsend = (method, params = {}) => new Promise((res) => { const i = ++bid; bpend.set(i, res); bws.send(JSON.stringify({ id: i, method, params })); });
            const w = await bsend('Browser.getWindowForTarget', { targetId: this.c.targetId });
            if (w.result?.windowId !== undefined) await bsend('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { left: 60, top: 40, width: 1400, height: 900, windowState: 'normal' } });
            bws.close();
        } catch (e) { console.warn('bounds:', e.message); }
        try {
            const pid = execSync(`lsof -ti :${PORT}`).toString().trim().split('\n')[0];
            execSync(`osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true'`);
        } catch (e) { console.warn('activate:', e.message.slice(0, 100)); }
        await sleep(700);
    }

    /** Inject demo cursor + click/type helpers + the consent auto-approver
     *  + the self-narration layer (title slides and lower-third captions
     *  baked into the frames — the videos explain themselves; music is
     *  added in post, no voiceover). */
    async inject() {
        await this.c.evaluate(`(() => {
            if (window.__demo) return true;
            const style = document.createElement('style');
            style.textContent = \`
              #__demo-cursor { position: fixed; z-index: 2147483647; width: 20px; height: 20px; margin: -10px 0 0 -10px;
                border-radius: 50%; background: rgba(20,20,20,.55); border: 2px solid rgba(255,255,255,.95);
                box-shadow: 0 1px 8px rgba(0,0,0,.35); pointer-events: none;
                transition: left .75s cubic-bezier(.45,.05,.25,1), top .75s cubic-bezier(.45,.05,.25,1), transform .12s ease, opacity .3s ease; }
              #__demo-cursor.press { transform: scale(.6); }
              #__demo-caption { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%);
                z-index: 2147483600; max-width: 780px; padding: 13px 26px; border-radius: 14px;
                background: rgba(17,17,17,.88); color: #fff;
                font-family: 'Nunito', -apple-system, sans-serif; font-size: 18px; font-weight: 600;
                line-height: 1.45; text-align: center; letter-spacing: .01em;
                box-shadow: 0 6px 28px rgba(0,0,0,.35); pointer-events: none;
                opacity: 0; transition: opacity .3s ease; }
              #__demo-caption.on { opacity: 1; }
              #__demo-slide { position: fixed; inset: 0; z-index: 2147483610;
                background: #fdfdfd; display: flex; flex-direction: column; align-items: center;
                justify-content: center; padding: 0 90px; text-align: center; pointer-events: none;
                opacity: 0; transition: opacity .45s ease; }
              #__demo-slide::before { content: ''; position: absolute; inset: 0; pointer-events: none;
                background: radial-gradient(ellipse 60% 50% at 18% 12%, rgba(99, 132, 255, .09), transparent 60%),
                            radial-gradient(ellipse 55% 50% at 84% 88%, rgba(240, 163, 94, .10), transparent 60%),
                            radial-gradient(ellipse 40% 40% at 70% 20%, rgba(94, 200, 168, .05), transparent 60%); }
              #__demo-slide.on { opacity: 1; }
              #__demo-slide .__ds-logo { width: 96px; height: 96px; border-radius: 22px;
                margin-bottom: 30px; box-shadow: 0 10px 30px rgba(40, 60, 110, .18); }
              #__demo-slide .__ds-eyebrow { font: 700 13px 'Nunito', sans-serif; letter-spacing: .3em;
                text-transform: uppercase; color: #8f9ab0; margin-bottom: 22px; }
              #__demo-slide h1 { font: 700 46px/1.15 'Nunito', -apple-system, sans-serif; color: #141414;
                margin: 0 0 16px; max-width: 800px; }
              #__demo-slide p { font: 400 20px/1.5 'Nunito', -apple-system, sans-serif; color: #545c68;
                margin: 0; max-width: 640px; }
              #__demo-slide .__ds-track { width: 220px; height: 3px; background: #ececec;
                margin-top: 40px; border-radius: 2px; overflow: hidden; }
              #__demo-slide .__ds-bar { width: 0; height: 100%; border-radius: 2px;
                background: linear-gradient(90deg, #6b8afd, #e8a15c); }
              #__demo-slide .__ds-cta { display: none; margin-top: 42px; }
              #__demo-slide .__ds-cta.show { display: block; animation: __dsRise .7s cubic-bezier(.2,.8,.3,1) both; }
              #__demo-slide .__ds-cta span { display: block; font: 400 17px 'Nunito', -apple-system, sans-serif;
                color: #545c68; margin-bottom: 10px; }
              #__demo-slide .__ds-cta strong { display: inline-block; font: 700 30px 'Nunito', -apple-system, sans-serif;
                color: #141414; padding-bottom: 6px;
                border-bottom: 3px solid transparent;
                border-image: linear-gradient(90deg, #6b8afd, #e8a15c) 1; }
              @keyframes __dsRise { from { opacity: 0; transform: translateY(18px); }
                to { opacity: 1; transform: none; } }
              @keyframes __dsPop { from { opacity: 0; transform: scale(.82); }
                to { opacity: 1; transform: scale(1); } }
              #__demo-slide.on .__ds-logo { animation: __dsPop .7s cubic-bezier(.2,.8,.3,1) both; }
              #__demo-slide.on .__ds-eyebrow { animation: __dsRise .6s .05s cubic-bezier(.2,.8,.3,1) both; }
              #__demo-slide.on h1 { animation: __dsRise .7s .15s cubic-bezier(.2,.8,.3,1) both; }
              #__demo-slide.on p { animation: __dsRise .7s .3s cubic-bezier(.2,.8,.3,1) both; }
              #__demo-slide.on .__ds-track { animation: __dsRise .6s .45s cubic-bezier(.2,.8,.3,1) both; }\`;
            document.head.appendChild(style);
            const cur = document.createElement('div');
            cur.id = '__demo-cursor';
            cur.style.left = '700px'; cur.style.top = '430px';
            // All injected chrome lives on <html>, NOT <body>: zoomIn()
            // scales body, and the cursor/caption/slide must not scale or
            // drift with it. Clicks still work while zoomed because
            // getBoundingClientRect() returns post-transform coordinates.
            document.documentElement.appendChild(cur);
            const wait = (ms) => new Promise(r => setTimeout(r, ms));
            window.__demo = {
                cur,
                find(sel, text) {
                    for (const el of document.querySelectorAll(sel)) {
                        if (el.offsetParent === null && !el.closest('dialog[open]')) continue;
                        if (!text || el.textContent.toLowerCase().includes(String(text).toLowerCase())) return el;
                    }
                    return null;
                },
                async moveTo(x, y) { cur.style.left = x + 'px'; cur.style.top = y + 'px'; await wait(800); },
                async clickEl(el) {
                    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    await wait(300);
                    const r = el.getBoundingClientRect();
                    const x = r.left + Math.min(r.width / 2, 140), y = r.top + r.height / 2;
                    await this.moveTo(x, y);
                    cur.classList.add('press'); await wait(130);
                    el.click();
                    cur.classList.remove('press'); await wait(200);
                    return true;
                },
                async click(sel, text) {
                    const el = this.find(sel, text);
                    if (!el) throw new Error('not found: ' + sel + (text ? ' ~ ' + text : ''));
                    return this.clickEl(el);
                },
                async type(inputEl, text, cps = 45) {
                    inputEl.focus();
                    for (let i = 1; i <= text.length; i++) {
                        inputEl.value = text.slice(0, i);
                        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                        await wait(cps);
                    }
                },
                // offsetParent alone LIES for the floating panel's composer:
                // the closed panel is position:fixed, translated off-screen,
                // so #agent-input passes every CSS visibility check while
                // being invisible — and askAndWait typed into it instead of
                // the home chatbox. A composer counts only when its center is
                // actually inside the viewport. Second pass: a composer that
                // is merely SCROLLED away (the dash composer after a feed
                // scroll) is brought back with scrollIntoView and re-checked
                // — the closed panel is position:fixed, so scrollIntoView
                // cannot move it on-screen and it still fails the check.
                visibleComposer() {
                    const onScreen = (el) => {
                        const r = el.getBoundingClientRect();
                        if (r.width < 1 || r.height < 1) return false;
                        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                        return cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;
                    };
                    const cands = ['agent-input', 'agent-app-input', 'dash-agent-input']
                        .map(id => document.getElementById(id))
                        .filter(el => el && el.offsetParent);
                    const visible = cands.find(onScreen);
                    if (visible) return visible;
                    for (const el of cands) {
                        el.scrollIntoView({ block: 'center' });
                        if (onScreen(el)) return el;
                    }
                    return null;
                },
                sendBtnFor(inputEl) {
                    const map = { 'agent-input': 'agent-send-btn', 'agent-app-input': 'agent-app-send-btn', 'dash-agent-input': 'dash-agent-send-btn' };
                    return document.getElementById(map[inputEl.id]);
                },
                askVisible() {
                    return !!document.querySelector('.agent-ask-card .agent-ask-allow')?.offsetParent
                        || !!this.find('dialog[open] button, .modal button', null && '');
                },
                /** Lower-third caption. caption(null) hides it; a new text
                 *  crossfades through a brief blank so the change reads. */
                caption(text) {
                    let el = document.getElementById('__demo-caption');
                    if (!el) { el = document.createElement('div'); el.id = '__demo-caption'; document.documentElement.appendChild(el); }
                    if (!text) { el.classList.remove('on'); return; }
                    if (el.classList.contains('on') && el.textContent !== text) {
                        el.classList.remove('on');
                        setTimeout(() => { el.textContent = text; el.classList.add('on'); }, 280);
                    } else { el.textContent = text; el.classList.add('on'); }
                },
                /** Full-screen title slide, held for holdMs. The progress
                 *  hairline animates the whole hold, which also keeps
                 *  screencast frames flowing (a static slide would collapse
                 *  into one frame under the dead-air cap). */
                async slide(title, sub, holdMs, opts) {
                    opts = opts || {};
                    let s = document.getElementById('__demo-slide');
                    if (!s) {
                        s = document.createElement('div');
                        s.id = '__demo-slide';
                        s.innerHTML = '<img class="__ds-logo" src="build/icon.png" alt="" hidden>'
                            + '<div class="__ds-eyebrow">Anjadhe</div><h1></h1><p></p>'
                            + '<div class="__ds-track"><div class="__ds-bar"></div></div>'
                            + '<div class="__ds-cta"><span>Download Anjadhe at</span><strong></strong></div>';
                        document.documentElement.appendChild(s);
                    }
                    s.querySelector('.__ds-logo').hidden = !opts.logo;
                    s.querySelector('h1').textContent = title;
                    const p = s.querySelector('p');
                    p.textContent = sub || '';
                    p.style.display = sub ? '' : 'none';
                    const cta = s.querySelector('.__ds-cta');
                    cta.classList.remove('show');
                    if (opts.cta) cta.querySelector('strong').textContent = opts.cta;
                    const bar = s.querySelector('.__ds-bar');
                    bar.style.transition = 'none'; bar.style.width = '0';
                    this.caption(null);
                    cur.style.opacity = '0';
                    // The entrance animations are keyed on .on, so re-adding
                    // the class replays them for every slide.
                    s.classList.add('on');
                    await wait(650);
                    bar.style.transition = 'width ' + holdMs + 'ms linear';
                    bar.style.width = '100%';
                    await wait(holdMs);
                    // The download instruction rises once the progress line
                    // completes; with stay:true the slide never fades, so
                    // the video ENDS on the call to action.
                    if (opts.cta) {
                        cta.classList.add('show');
                        await wait(700);
                        await this.holdLive(opts.ctaHold || 3400);
                    }
                    if (opts.stay) return;
                    s.classList.remove('on');
                    cur.style.opacity = '1';
                    await wait(450);
                },
                /** Cinematic zoom toward one element: scales <body> about
                 *  the element's center (the injected chrome lives on <html>
                 *  and stays put). Element is measured UNZOOMED, so calling
                 *  zoomIn while zoomed resets first. */
                async zoomIn(sel, text, scale) {
                    scale = scale || 1.6;
                    const b = document.body;
                    if (b.style.transform && b.style.transform !== 'none') {
                        b.style.transition = 'none'; b.style.transform = 'none';
                        await wait(60);
                    }
                    const el = this.find(sel, text);
                    if (!el) throw new Error('zoom: not found ' + sel + (text ? ' ~ ' + text : ''));
                    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    await wait(600);
                    const r = el.getBoundingClientRect();
                    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
                    document.documentElement.style.overflow = 'hidden';
                    b.style.transformOrigin = cx + 'px ' + cy + 'px';
                    b.style.transition = 'transform 1s cubic-bezier(.4,.05,.2,1)';
                    b.style.transform = 'scale(' + scale + ')';
                    await wait(1050);
                },
                async zoomOut() {
                    const b = document.body;
                    if (!b.style.transform || b.style.transform === 'none') return;
                    b.style.transition = 'transform .9s cubic-bezier(.4,.05,.2,1)';
                    b.style.transform = 'none';
                    await wait(950);
                    b.style.transition = ''; b.style.transform = ''; b.style.transformOrigin = '';
                    document.documentElement.style.overflow = '';
                },
                /** Keep screencast frames flowing for ms of stillness (a 3px
                 *  corner dot flickers imperceptibly) so caption reading time
                 *  survives the concat dead-air cap. */
                async holdLive(ms) {
                    let pump = document.getElementById('__demo-pump');
                    if (!pump) {
                        pump = document.createElement('div');
                        pump.id = '__demo-pump';
                        // Above the slide (2147483610): during a closing
                        // slide's CTA hold the pump is the only thing
                        // changing, and an occluded pump stops the frames.
                        pump.style.cssText = 'position:fixed;right:2px;bottom:2px;width:3px;height:3px;z-index:2147483620;pointer-events:none;border-radius:50%;background:rgba(0,0,0,.02);';
                        document.documentElement.appendChild(pump);
                    }
                    const t0 = Date.now(); let f = false;
                    while (Date.now() - t0 < ms) {
                        pump.style.background = (f = !f) ? 'rgba(0,0,0,.05)' : 'rgba(0,0,0,.02)';
                        await wait(260);
                    }
                    pump.remove();
                },
            };
            // Consent auto-approver: when an Allow appears, give the viewer
            // time to READ the dialog, then click it with the demo cursor.
            window.__demoAskSeen = 0;
            window.__demoAskTimer = setInterval(async () => {
                if (window.__demoBusy) return;
                const inline = document.querySelector('.agent-ask-allow');
                const modal = [...document.querySelectorAll('dialog[open] button.primary-btn, .modal button.primary-btn')]
                    .find(b => b.textContent.trim() === 'Allow');
                const btn = (inline && inline.offsetParent) ? inline : modal;
                if (btn && !btn.__demoClicked) {
                    btn.__demoClicked = true;
                    window.__demoBusy = true;
                    window.__demoAskSeen += 1;
                    // A story may stage a caption for the consent moment —
                    // it flips on WITH the dialog, and earns a longer read.
                    if (window.__demoCaptionOnAsk) window.__demo.caption(window.__demoCaptionOnAsk);
                    await wait(window.__demoCaptionOnAsk ? 3600 : 2600);
                    try { await window.__demo.clickEl(btn); } catch (e) {}
                    window.__demoBusy = false;
                }
            }, 700);
            return true;
        })()`);
    }

    async record(outDir) {
        this.out = path.resolve(outDir);
        outDir = this.out;
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.mkdirSync(outDir, { recursive: true });
        this.times = []; this.n = 0;
        this.c.on('Page.screencastFrame', (p) => {
            this.n += 1;
            fs.writeFileSync(path.join(outDir, 'f' + String(this.n).padStart(5, '0') + '.jpg'), Buffer.from(p.data, 'base64'));
            this.times.push(p.metadata.timestamp);
            this.c.send('Page.screencastFrameAck', { sessionId: p.sessionId });
        });
        await this.c.send('Page.enable');
        await this.c.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 2800, maxHeight: 1800, everyNthFrame: 1 });
    }

    /** Remove everything inject() put in the page (cursor, caption, slide,
     *  frame pump, the consent-watcher interval) so the instance is clean
     *  after a take. Safe to call twice; a later inject() rebuilds. */
    async cleanup() {
        try {
            await this.c.evaluate(`(() => {
                clearInterval(window.__demoAskTimer);
                for (const id of ['__demo-cursor', '__demo-caption', '__demo-slide', '__demo-pump'])
                    document.getElementById(id)?.remove();
                const b = document.body;
                b.style.transform = ''; b.style.transformOrigin = ''; b.style.transition = '';
                document.documentElement.style.overflow = '';
                window.__demoCaptionOnAsk = null;
                delete window.__demo;
                return true;
            })()`);
        } catch (e) { console.warn('cleanup:', e.message.slice(0, 100)); }
    }

    /** Stop + write concat manifest; dead air is capped at `capSec` per frame.
     *  Also cleans the injected demo chrome out of the page — the recording
     *  is over, the dotted cursor must not stay behind. */
    async stop(capSec = 3.5) {
        await this.c.send('Page.stopScreencast');
        await sleep(300);
        await this.cleanup();
        const t = this.times;
        const lines = [];
        for (let i = 0; i < t.length; i++) {
            lines.push(`file '${path.join(this.out, 'f' + String(i + 1).padStart(5, '0') + '.jpg')}'`);
            const dur = i + 1 < t.length ? Math.min(t[i + 1] - t[i], capSec) : 2.0;
            lines.push(`duration ${Math.max(dur, 0.01).toFixed(4)}`);
        }
        if (t.length) lines.push(`file '${path.join(this.out, 'f' + String(t.length).padStart(5, '0') + '.jpg')}'`);
        fs.writeFileSync(path.join(this.out, 'concat.txt'), lines.join('\n'));
        fs.writeFileSync(path.join(this.out, 'times.json'), JSON.stringify(t));
        console.log('frames:', this.n);
    }

    async step(name, fn) {
        try { await fn(); console.log('ok  :', name); }
        catch (e) { console.log('SKIP:', name, '-', e.message.slice(0, 200)); }
    }

    click(sel, text, settle = 900) {
        return this.E(`await __demo.click(${JSON.stringify(sel)}, ${text ? JSON.stringify(text) : 'null'});`).then(() => sleep(settle));
    }

    /** Full-screen title slide (baked into the frames), held holdMs.
     *  opts.logo shows the app icon above the title (the intro slide). */
    slide(title, sub, holdMs = 3600, opts = null) {
        return this.E(`await __demo.slide(${JSON.stringify(title)}, ${JSON.stringify(sub || '')}, ${holdMs}, ${JSON.stringify(opts)});`);
    }

    /** Set (or with null, clear) the lower-third caption. With holdMs the
     *  screen holds that long with frames flowing, so the text stays
     *  readable even over a still screen. */
    cap(text, holdMs = 0) {
        return this.E(`__demo.caption(${JSON.stringify(text ?? null)});${holdMs ? ` await __demo.holdLive(${holdMs});` : ''}`);
    }

    /** Stage a caption that appears the moment a consent dialog does (the
     *  auto-approver flips it on and holds the dialog longer). Null clears. */
    capOnAsk(text) {
        return this.E(`window.__demoCaptionOnAsk = ${JSON.stringify(text ?? null)};`);
    }

    /**
     * Zoom the app toward one element (found by selector + optional text),
     * optionally set a caption, hold with frames flowing, then zoom back.
     * Pass holdMs: 0 to stay zoomed (for a click while zoomed) and call
     * d.zoomOut() yourself.
     */
    async zoomIn(sel, text, { scale = 1.6, caption = null, holdMs = 2800 } = {}) {
        await this.E(`await __demo.zoomIn(${JSON.stringify(sel)}, ${text ? JSON.stringify(text) : 'null'}, ${scale});`);
        if (caption) await this.cap(caption);
        if (holdMs) {
            await this.E(`await __demo.holdLive(${holdMs});`);
            await this.zoomOut();
        }
    }

    zoomOut() {
        return this.E(`await __demo.zoomOut();`);
    }

    /**
     * Open a goal's DETAIL by title regex. Camera-clicks a real door — the
     * goal card header or a nav row (via its group first when the page is
     * on another group) — and falls back to GoalsPage.selectNode, which is
     * exactly what those doors call. Never text-hunts generic divs: a
     * wrapper whose text merely CONTAINS the title wins the find and the
     * cursor clicks dead space (the 2026-08-22 overview bug).
     */
    async openGoal(titleRx) {
        await this.E(`
            const goal = (StorageManager.get('goals')?.goals || [])
                .find(g => new RegExp(${JSON.stringify(titleRx)}, 'i').test(g.title || ''));
            if (!goal) throw new Error('goal not found: ' + ${JSON.stringify(titleRx)});
            const door = () => __demo.find(
                '#goals-view .goals-card-header[data-goal-id="' + goal.id + '"],' +
                ' #goals-view [data-open-goal="' + goal.id + '"]', null);
            let el = door();
            if (!el && goal.group) {
                const nav = __demo.find('#goals-nav button, #goals-nav a, #goals-nav li, #goals-nav [role="button"]', goal.group);
                if (nav) { await __demo.clickEl(nav); await new Promise(r => setTimeout(r, 1000)); el = door(); }
            }
            if (el) await __demo.clickEl(el);
            else GoalsPage.selectNode('goal', goal.id);`);
        await sleep(2200);
    }

    /** Type into the visible composer, send, and wait for the turn (stream +
     *  any consent asks) to fully settle. opts.zoom (a scale, e.g. 1.45)
     *  dives the camera onto the composer for the typing and pulls back as
     *  the send fires, so the answer streams at normal framing. */
    async askAndWait(text, maxMs = 120000, { zoom = 0 } = {}) {
        await this.E(`
            const input = __demo.visibleComposer();
            if (!input) throw new Error('no visible composer');
            ${zoom ? `await __demo.zoomIn('#' + input.id, null, ${zoom});` : ''}
            const r = input.getBoundingClientRect();
            await __demo.moveTo(r.left + Math.min(r.width / 2, 200), r.top + r.height / 2);
            await __demo.type(input, ${JSON.stringify(text)});`);
        await sleep(400);
        await this.E(`
            const input = __demo.visibleComposer();
            const btn = __demo.sendBtnFor(input);
            if (btn && btn.offsetParent) await __demo.clickEl(btn);
            else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            ${zoom ? 'await __demo.zoomOut();' : ''}`);
        // A turn is over only when the ASSISTANT'S message has landed —
        // "not streaming" alone lies during tool round-trips and consent
        // asks (the gap between streams reads as quiet).
        await this.E(`
            const lastRole = () => {
                const cs = AgentService.conversations || [];
                const arr = Array.isArray(cs) ? cs : Object.values(cs);
                const c0 = arr.find(x => x.id === AgentService.activeConversationId) || arr[0];
                const msgs = c0?.messages || [];
                return msgs.length ? msgs[msgs.length - 1].role : null;
            };
            const t0 = Date.now();
            let quiet = 0;
            while (Date.now() - t0 < ${maxMs}) {
                const streaming = (AgentService.getActiveStreamingConvIds?.() || []).length > 0;
                const asking = !!document.querySelector('.agent-ask-card') || window.__demoBusy;
                if (!streaming && !asking && lastRole() === 'assistant' && Date.now() - t0 > 4000) { quiet += 1; if (quiet >= 3) break; }
                else quiet = 0;
                await new Promise(r => setTimeout(r, 850));
            }`);
        await sleep(1200);
    }

    /** Poll an in-page predicate until true or timeout. */
    async waitFor(js, maxMs = 60000, label = 'condition') {
        const t0 = Date.now();
        while (Date.now() - t0 < maxMs) {
            if (await this.c.evaluate(`(() => { try { return !!(${js}); } catch (e) { return false; } })()`)) return true;
        await sleep(1500);
        }
        console.warn('waitFor timeout:', label);
        return false;
    }
}
