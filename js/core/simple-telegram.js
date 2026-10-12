/**
 * SimpleSettings › On your phone (2026-10-08): Telegram, set up in three
 * guided steps on the simple Settings page (docs/growth/personas.md: the
 * Mac is the product, Telegram is how a person reaches it from the phone).
 *
 * The person still makes their OWN bot, so the Mac talks to Telegram
 * directly and no nenva server sees the messages (option A; a shared nenva
 * bot would route every message through Connect). What changed is the
 * work around it:
 *   1. Make your bot: BotFather opens from a button or a QR, and the words
 *      to send it are copy buttons.
 *   2. Paste the token: a Paste button, and a pasted token connects by
 *      itself; the bot is switched on and given nenva's description.
 *   3. Link your phone: a QR / button opens the bot with the code attached,
 *      so pressing Start links it (telegram-bridge.js reads "/start <code>");
 *      the six digits stay as the fallback. Linking from this page turns on
 *      "nenva reaches you", which the step says before it happens; one
 *      switch turns it off.
 *
 * Nothing here is a second copy of the machinery: every action is the
 * window.electronTelegram call the Advanced card (SettingsApp._renderTelegram)
 * already uses, and the status read refreshes Notify's forwarding cache
 * the same way. Approvals are still declined in Telegram and done here.
 */
Object.assign(SimpleSettings, {

    _tg: null,              // last status from main
    _tgLink: null,          // { code, link, qr } while linking from this page
    _tgPoll: null,
    _tgError: '',
    _tgBusy: false,
    _tgNotifyOnLink: false, // linking began here, so "nenva reaches you" turns on when it lands

    _TG_TOKEN_RX: /^\d{5,}:[A-Za-z0-9_-]{30,}$/,

    /** The root row's value: read once per render of the root page. */
    _phoneRowValue() {
        const st = this._tg;
        if (!st) return '';
        if (!st.configured) return 'Set up';
        if (!st.chat) return 'Finish setup';
        return st.enabled ? 'Telegram' : 'Telegram · Off';
    },
    _fillPhone() {
        if (!window.electronTelegram) return;
        window.electronTelegram.getStatus().then(st => {
            this._tg = st;
            if (typeof Notify !== 'undefined' && Notify.refreshTelegram) Notify.refreshTelegram(st);
            const el = document.querySelector('#simplesettings-view .ss-phone-value');
            if (el && this._page === 'root') el.textContent = this._phoneRowValue();
        }).catch(() => {});
    },

    async _renderPhone(wrap) {
        if (!window.electronTelegram) {
            wrap.innerHTML = `${this._phoneHead()}<p class="ss-lede">Telegram isn't available in this build.</p>`;
            return;
        }
        let st;
        try { st = await window.electronTelegram.getStatus(); } catch { return; }
        if (this._page !== 'phone') return;
        this._tg = st;
        if (typeof Notify !== 'undefined' && Notify.refreshTelegram) Notify.refreshTelegram(st);

        // A code lives ten minutes; once it has lapsed, begin a fresh one.
        if (this._tgLink && !st.linking) this._tgLink = null;
        // Configured but no chat yet: begin linking here, so step 3 has its
        // link and QR without another click. The bridge only reads codes
        // while it polls, so it is switched on first.
        if (st.configured && !st.chat && !this._tgLink) {
            if (!st.enabled) { await window.electronTelegram.setEnabled(true); st.enabled = true; }
            const res = await window.electronTelegram.beginLink().catch(() => null);
            if (this._page !== 'phone') return;
            if (res && res.code) { this._tgLink = res; this._tgNotifyOnLink = true; }
        }
        if (st.chat) this._tgLink = null;

        wrap.innerHTML = !st.configured ? this._phoneSetupHtml(st)
            : !st.chat ? this._phoneLinkHtml(st)
            : this._phoneLinkedHtml(st);
        this._wirePhone(wrap);
        this._tgStartPoll();
    },

    _phoneHead() {
        return `<button type="button" class="ss-back" data-ss="back">‹ Settings</button>
            <h1 class="ss-title">On your phone</h1>`;
    },

    _phoneLede() {
        return `<p class="ss-lede">Through Telegram, you can reach nenva from your phone, and nenva can reach you. Your Mac does the work, so this works while your Mac is on. Messages travel through Telegram's servers.</p>`;
    },

    _copyChip(text) {
        return `<button type="button" class="ss-tg-chip" data-ss="tg-copy" data-id="${this._esc(text)}" title="Copy">${this._esc(text)}<span class="ss-tg-chip-act">Copy</span></button>`;
    },

    _phoneSetupHtml(st) {
        const bf = st.botFather || {};
        const err = this._tgError ? `<p class="ss-note ss-warn">${this._esc(this._tgError)}</p>` : '';
        return `${this._phoneHead()}${this._phoneLede()}
            <p class="ss-eyebrow">Step 1 of 3 · Make your bot</p>
            <div class="ss-group">
                <div class="ss-row ss-field-row ss-tg-step">
                    <span class="ss-pick-copy">
                        <span class="ss-label">Open BotFather in Telegram</span>
                        <span class="ss-sub">Telegram's own helper for making bots. Use the button on this Mac, or scan the code with your phone's camera.</span>
                        <span class="ss-tg-actions"><button type="button" class="ss-btn" data-ss="tg-open" data-id="${this._esc(bf.url || 'https://t.me/BotFather')}">Open BotFather</button></span>
                    </span>
                    ${bf.qr ? `<span class="ss-tg-qr">${bf.qr}</span>` : ''}
                </div>
                <div class="ss-row ss-field-row ss-tg-step">
                    <span class="ss-pick-copy">
                        <span class="ss-label">Send it these, one at a time</span>
                        <span class="ss-tg-lines">
                            <span>${this._copyChip('/newbot')}</span>
                            <span>A name: ${this._copyChip('nenva')}</span>
                            <span>A username that ends in <em>bot</em>, like ${this._copyChip('yourname_nenva_bot')} (if it's taken, add a number)</span>
                        </span>
                        <span class="ss-sub">BotFather replies with a token, a long line with a colon in it. Copy it.</span>
                    </span>
                </div>
            </div>
            <p class="ss-eyebrow">Step 2 of 3 · Paste the token</p>
            <div class="ss-group">
                <div class="ss-row ss-field-row">
                    <input type="password" class="ss-input ss-tg-token" placeholder="Token from BotFather" autocomplete="off" spellcheck="false" aria-label="Bot token from BotFather">
                    <button type="button" class="ss-btn" data-ss="tg-paste"${this._tgBusy ? ' disabled' : ''}>Paste</button>
                    <button type="button" class="ss-btn ss-btn-primary" data-ss="tg-connect"${this._tgBusy ? ' disabled' : ''}>${this._tgBusy ? 'Connecting…' : 'Connect'}</button>
                </div>
            </div>
            ${err}
            <p class="ss-note">The token is stored encrypted on this Mac. Set this up on one Mac only: Telegram lets one app listen to a bot.</p>`;
    },

    _phoneLinkHtml(st) {
        const bot = st.bot && st.bot.username ? '@' + st.bot.username : 'your bot';
        const l = this._tgLink;
        const body = l && l.code ? `
                <div class="ss-row ss-field-row ss-tg-step">
                    <span class="ss-pick-copy">
                        <span class="ss-label">Scan this with your phone, then press Start</span>
                        <span class="ss-sub">It opens ${this._esc(bot)} in Telegram with your code attached. Already using Telegram on this Mac? Open it here instead.</span>
                        <span class="ss-tg-actions">${l.link ? `<button type="button" class="ss-btn ss-btn-primary" data-ss="tg-open" data-id="${this._esc(l.link)}">Open in Telegram</button>` : ''}</span>
                        <span class="ss-sub">Or send <strong>${this._esc(l.code)}</strong> to ${this._esc(bot)}. The code works for 10 minutes.</span>
                    </span>
                    ${l.qr ? `<span class="ss-tg-qr">${l.qr}</span>` : ''}
                </div>`
            : `<div class="ss-row ss-field-row"><span class="ss-pick-copy"><span class="ss-label">Couldn't start linking</span><span class="ss-sub">${this._esc(st.lastError || 'Telegram did not answer.')}</span></span>
                <button type="button" class="ss-btn" data-ss="tg-relink">Try again</button></div>`;
        return `${this._phoneHead()}${this._phoneLede()}
            <p class="ss-eyebrow">Step 3 of 3 · Link your phone</p>
            <div class="ss-group">${body}</div>
            <p class="ss-note">Only the chat that links is answered; anyone else who finds the bot gets no reply. Once it's linked, nenva can also reach you there, and you can turn that off afterwards.</p>
            <p class="ss-note"><button type="button" class="ss-link" data-ss="tg-disconnect">Start over with another bot</button></p>`;
    },

    _phoneLinkedHtml(st) {
        const bot = st.bot && st.bot.username ? st.bot.username : '';
        let line = 'Listening for your messages.';
        let warn = false;
        if (st.lastError) { line = st.enabled && st.running ? `Reconnecting: ${st.lastError}` : st.lastError; warn = true; }
        else if (!st.enabled) line = 'Off. nenva does not answer messages here.';
        return `${this._phoneHead()}
            <p class="ss-lede">Connected to ${bot ? '@' + this._esc(bot) : 'your bot'}, linked to ${this._esc((st.chat && st.chat.name) || 'your chat')}. Write to it like you would in nenva. It answers while your Mac is on, and when nenva needs your OK, like before sending an email, it asks there with Allow and Not now.</p>
            <p class="ss-note${warn ? ' ss-warn' : ''} ss-tg-line">${this._esc(line)}</p>
            <div class="ss-group">
                <label class="ss-row ss-switch-row">
                    <span class="ss-pick-copy"><span class="ss-label">You reach nenva</span><span class="ss-sub">nenva answers what you write to it.</span></span>
                    <span class="settings-switch"><input type="checkbox" data-ss-tg="enabled" ${st.enabled ? 'checked' : ''} aria-label="You reach nenva in Telegram"><span class="settings-switch-track"></span></span>
                </label>
                <label class="ss-row ss-switch-row">
                    <span class="ss-pick-copy"><span class="ss-label">nenva reaches you</span><span class="ss-sub">New cards on Now, the things you planned at a time, and anything waiting for your OK. Nothing else.</span></span>
                    <span class="settings-switch"><input type="checkbox" data-ss-tg="notify" ${st.notify ? 'checked' : ''} aria-label="nenva reaches you in Telegram"><span class="settings-switch-track"></span></span>
                </label>
            </div>
            <div class="ss-group">
                ${bot ? `<button type="button" class="ss-row" data-ss="tg-open" data-id="https://t.me/${this._esc(encodeURIComponent(bot))}"><span class="ss-label">Open the chat in Telegram</span>${this._chev}</button>` : ''}
                <button type="button" class="ss-row" data-ss="tg-unlink"><span class="ss-label">Link a different chat</span>${this._chev}</button>
                <button type="button" class="ss-row" data-ss="tg-disconnect"><span class="ss-label ss-warn">Disconnect Telegram</span></button>
            </div>`;
    },

    _wirePhone(wrap) {
        const input = wrap.querySelector('.ss-tg-token');
        if (input) {
            // A pasted token connects by itself: there is nothing else to do.
            input.addEventListener('input', () => {
                if (this._TG_TOKEN_RX.test(input.value.trim())) this._tgConnect(input.value.trim());
            });
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._tgConnect(input.value.trim()); });
        }
        wrap.querySelectorAll('[data-ss-tg]').forEach(sw => sw.addEventListener('change', async () => {
            if (sw.dataset.ssTg === 'enabled') await window.electronTelegram.setEnabled(sw.checked);
            if (sw.dataset.ssTg === 'notify') await window.electronTelegram.setNotify(sw.checked);
            this.render();
        }));
    },

    async _tgConnect(token) {
        if (this._tgBusy) return;
        if (!token) { this._tgError = 'Paste the token BotFather sent you.'; this.render(); return; }
        this._tgBusy = true; this._tgError = '';
        this.render();
        const res = await window.electronTelegram.setToken(token).catch(e => ({ error: e.message }));
        this._tgBusy = false;
        if (res && res.error) { this._tgError = res.error; this.render(); return; }
        await window.electronTelegram.setEnabled(true);
        this._tgLink = null;
        this.render();
    },

    /** While the page is open: notice the link landing, and keep the status line true. */
    _tgStartPoll() {
        if (this._tgPoll) return;
        this._tgPoll = setInterval(async () => {
            if (this._page !== 'phone') { clearInterval(this._tgPoll); this._tgPoll = null; return; }
            let st;
            try { st = await window.electronTelegram.getStatus(); } catch { return; }
            const was = this._tg;
            this._tg = st;
            if (st.chat && was && !was.chat) {
                if (this._tgNotifyOnLink && !st.notify) await window.electronTelegram.setNotify(true);
                this._tgNotifyOnLink = false;
                this.render();
                return;
            }
            if (was && (was.lastError !== st.lastError || was.enabled !== st.enabled || was.linking !== st.linking)) this.render();
        }, 2000);
    },

    async _phoneAct(ss, id, b) {
        const tg = window.electronTelegram;
        if (!tg) return;
        if (ss === 'tg-open' && id) { AppManager.openExternal(id); return; }
        if (ss === 'tg-copy' && id) {
            try { await navigator.clipboard.writeText(id); } catch { return; }
            const act = b.querySelector('.ss-tg-chip-act');
            if (act) { act.textContent = 'Copied'; setTimeout(() => { act.textContent = 'Copy'; }, 1400); }
            return;
        }
        if (ss === 'tg-paste') {
            const input = b.closest('.ss-row') && b.closest('.ss-row').querySelector('.ss-tg-token');
            let text = '';
            try { text = (await navigator.clipboard.readText()).trim(); } catch { /* fall through */ }
            if (!text) { this._tgError = 'Nothing to paste. Copy the token in Telegram first, or press Command-V in the box.'; this.render(); return; }
            if (input) input.value = text;
            this._tgConnect(text);
            return;
        }
        if (ss === 'tg-connect') {
            const input = document.querySelector('#simplesettings-view .ss-tg-token');
            this._tgConnect(input ? input.value.trim() : '');
            return;
        }
        if (ss === 'tg-relink' || ss === 'tg-unlink') {
            if (ss === 'tg-unlink') await tg.unlink();
            this._tgLink = null;
            this.render();
            return;
        }
        if (ss === 'tg-disconnect') {
            if (!window.confirm('Disconnect Telegram? The bot token and the linked chat are removed from this Mac.')) return;
            await tg.disconnect();
            this._tgLink = null; this._tgError = '';
            this.render();
        }
    }
});
