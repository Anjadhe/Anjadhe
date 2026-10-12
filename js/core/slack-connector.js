/** Slack's plain-language door onto the existing machine-local MCP connection.
 * Monitoring is separately reviewed and remains behind its main release gate.
 */
const SlackConnector = {
    URL: 'https://mcp.slack.com/mcp',
    _servers: [],
    _loaded: false,
    _busy: false,
    _error: '',
    _readError: '',
    _revision: 0,
    _monitor: null,
    _setup: null,
    _monitorError: '',
    _monitorBusy: false,

    matches(server) { return server.auth === 'oauth' && server.url?.replace(/\/$/, '') === this.URL; },
    server() {
        const matches = this._servers.filter(s => this.matches(s));
        return matches.find(s => s.authStatus === 'connecting')
            || matches.find(s => s.enabled && s.authStatus === 'connected') || matches[0];
    },
    status() {
        const server = this.server();
        const refused = server?.authStatus === 'connected' ? server.connectError || '' : '';
        const on = !!(server?.enabled && server.authStatus === 'connected' && !refused);
        const connecting = server?.authStatus === 'connecting';
        const error = this._error || this._readError || refused;
        return { on, error: !!error || server?.authStatus === 'reconnect',
            value: !window.electronMCP ? 'Not available' : this._readError ? 'Needs attention' : !this._loaded ? 'Loading…'
                : connecting ? 'Waiting for sign-in' : this._busy ? 'Connecting…'
                    : error ? 'Needs attention' : on ? 'Connected'
                        : server?.authStatus === 'reconnect' ? 'Sign in again'
                            : server && !server.enabled ? 'Off' : 'Not connected',
            detail: error };
    },
    _changed() { window.dispatchEvent(new CustomEvent('anjadhe:connectors-changed')); },
    async refresh() {
        if (!window.electronMCP) return;
        const revision = ++this._revision;
        try {
            const servers = await window.electronMCP.listServers();
            if (revision !== this._revision) return;
            this._servers = servers;
            this._loaded = true;
            this._readError = '';
            if (window.electronSlackMonitor) {
                const monitor = await window.electronSlackMonitor.status().catch(() => null);
                if (revision !== this._revision) return;
                this._monitor = monitor?.error ? null : monitor;
            }
        } catch {
            if (revision !== this._revision) return;
            this._readError = 'Could not check your Slack connection. Try again.';
        }
        this._changed();
    },
    /** The model the setup reads with: the person's own default model when
     * the reviewed catalog holds it, else their explicit pick (the native
     * review dialog still names it before anything is approved). */
    _setupModel() {
        const setup = this._setup;
        if (!setup) return null;
        if (setup.modelId) return setup.models.find(m => m.id === setup.modelId) || null;
        let def = null;
        try { def = typeof AgentService !== 'undefined' ? AgentService.getDefaultEntry() : null; } catch { def = null; }
        return (def && setup.models.find(m => m.id === def.id)) || null;
    },
    /** The four words a person can act on; the counters live with the logs. */
    _watchState() {
        const s = this._monitor;
        if (!s?.configured) return null;
        const needsLook = { model_changed: 'Your AI model changed. Choose conversations again to confirm it.',
            privacy_blocked: 'Your privacy settings keep Slack from your AI model.',
            cloud_policy_unavailable: 'Watching with a cloud model is not available yet. Choose a model on this Mac.',
            budget_unavailable: 'nenva could not check its usage limit. It will try again.' };
        if (!s.available) return { value: 'Not available', sub: 'Watching is not available in this version.', error: false };
        if (s.outcome === 'needs_sign_in') return { value: 'Needs sign-in', sub: 'Sign in to Slack again to keep watching.', error: true };
        if (s.paused) return { value: 'Paused', sub: 'Nothing is read while paused.', error: false };
        if (needsLook[s.analysisState]) return { value: 'Needs a look', sub: needsLook[s.analysisState], error: true };
        if (s.outcome === 'store_unavailable') return { value: 'Needs a look', sub: 'nenva could not open its Slack queue on this Mac.', error: true };
        const last = s.lastReadAt ? `Last checked ${this._when(s.lastReadAt)}` : 'First check is on its way';
        const catching = s.running === false || s.pending || (s.analysisState && s.analysisState !== 'ready') || s.channels?.some(c => c.error);
        return { value: catching ? 'Catching up' : 'Watching', sub: last, error: false };
    },
    _when(at) {
        try { return typeof UIUtils !== 'undefined' && UIUtils.formatDateTime ? UIUtils.formatDateTime(at) : new Date(at).toLocaleString(); }
        catch { return ''; }
    },
    /** One row on the Slack page; nothing at all while watching is unreleased. */
    watchRowHtml(esc, chev = '') {
        const s = this._monitor;
        if (!s?.available && !s?.configured) return '';
        const st = this._watchState();
        return `<button type="button" class="ss-row" data-ss="page" data-id="connector:slack:watch"><span class="ss-label">Keep an eye on Slack</span><span class="ss-value${st?.error ? ' ss-error' : ''}">${esc(st ? st.value : 'Off')}</span>${chev}</button>`;
    },
    monitoringHtml(esc) {
        const status = this._monitor;
        if (!status?.available && !status?.configured) return '';
        const disabled = this._monitorBusy ? 'disabled' : '';
        const error = this._monitorError ? `<p class="ss-foot ss-error" role="alert">${esc(this._monitorError)}</p>` : '';
        const lede = '<p class="ss-lede">nenva looks for requests that need you, things you said you would do, and decisions that change your work. What needs you shows up on Now.</p>';
        if (this._setup && status.available) return this._pickerHtml(esc, disabled) + error;
        if (!status.configured) {
            return `${lede}<div class="ss-group"><button type="button" class="ss-row" data-ss="slack-monitor-setup" ${disabled}><span class="ss-label ss-accent">Choose conversations</span></button></div>
                <p class="ss-foot">Nothing is read until you choose conversations and confirm.</p>${error}`;
        }
        const st = this._watchState();
        const n = status.scope?.conversationIds?.length || 0;
        const head = st.value === 'Watching' || st.value === 'Catching up'
            ? `${st.value} ${n} conversation${n === 1 ? '' : 's'}`.replace('Catching up', 'Catching up on') : st.value;
        const review = this._reviewRoutine();
        return `${lede}<div class="ss-group">
                <div class="ss-row ss-two" role="status"><span class="ss-pick-copy"><span class="ss-label">${esc(head)}</span><span class="ss-sub${st.error ? ' ss-error' : ''}">${esc(st.sub)}</span></span></div>
                ${status.available ? `<button type="button" class="ss-row" data-ss="slack-monitor-setup" ${disabled}><span class="ss-label">Change conversations</span></button>` : ''}
                ${status.available || !status.paused ? `<button type="button" class="ss-row" data-ss="slack-monitor-${status.paused ? 'resume' : 'pause'}" ${disabled}><span class="ss-label">${status.paused ? 'Resume' : 'Pause'}</span></button>` : ''}
            </div>
            ${status.available ? `<div class="ss-group"><button type="button" class="ss-row" data-ss="slack-monitor-review-morning" ${disabled}><span class="ss-label">${review ? 'Morning review' : 'Add a morning review'}</span><span class="ss-value">${review ? 'Open' : ''}</span></button></div>
                <p class="ss-foot">${review ? 'Talk to it in its chat to change what it gathers.' : 'Each morning at 8, gathers what is new from these conversations into one chat. Urgent things still show up on Now.'}</p>` : ''}
            <div class="ss-group"><button type="button" class="ss-row" data-ss="slack-monitor-stop" ${disabled}><span class="ss-label ss-danger">Stop watching</span></button></div>${error}`;
    },
    _pickerHtml(esc, disabled) {
        const setup = this._setup, q = String(setup.query || '').toLowerCase().trim();
        const row = c => {
            const name = c.name || c.peerId || c.id;
            const hide = q && !String(name).toLowerCase().includes(q) ? ' hidden' : '';
            return `<label class="ss-row" data-slack-name="${esc(String(name).toLowerCase())}"${hide}><span class="ss-label">${esc(c.type === 'im' || c.type === 'mpim' ? name : `#${String(name).replace(/^#/, '')}`)}</span><input type="checkbox" data-slack-conversation="${esc(c.id)}" ${setup.selected.has(c.id) ? 'checked' : ''} ${disabled}></label>`;
        };
        const people = setup.conversations.filter(c => c.type === 'im' || c.type === 'mpim');
        const channels = setup.conversations.filter(c => !(c.type === 'im' || c.type === 'mpim'));
        const model = this._setupModel();
        const modelLine = model
            ? `<p class="ss-foot">Reads with ${esc(model.label)}${model.engine === 'llamacpp' ? ', on this Mac' : ', which leaves this Mac'}. <button type="button" class="ss-link" data-ss="page" data-id="model">Change</button></p>`
            : `<div class="ss-group"><label class="ss-row"><span class="ss-label">Read with</span><select class="ss-select" data-slack-model ${disabled}><option value="">Choose a model</option>${setup.models.map(m => `<option value="${esc(m.id)}">${esc(m.label)} · ${m.engine === 'llamacpp' ? 'On this Mac' : 'Leaves this Mac'}</option>`).join('')}</select></label></div>`;
        return `<p class="ss-lede">Choose the conversations in ${esc(setup.workspaceName || 'your workspace')} where things for you come up.</p>
            <div class="ss-connector-search" role="search"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
                <input type="search" class="ss-find" data-slack-find placeholder="Search people and channels" aria-label="Search Slack conversations" autocomplete="off" spellcheck="false" value="${esc(setup.query || '')}"></div>
            <p class="ss-search-count" data-slack-count role="status" aria-live="polite">${setup.selected.size} of 20 chosen</p>
            ${people.length ? `<p class="ss-eyebrow">People</p><div class="ss-group">${people.map(row).join('')}</div>` : ''}
            ${channels.length ? `<p class="ss-eyebrow">Channels</p><div class="ss-group">${channels.map(row).join('')}</div>` : ''}
            ${!setup.conversations.length ? '<p class="ss-empty">No conversations found.</p>' : ''}
            ${setup.more ? `<div class="ss-group"><button type="button" class="ss-row" data-ss="slack-monitor-more" ${disabled}><span class="ss-label">Show more</span></button></div>` : ''}
            ${modelLine}
            <div class="ss-group"><button type="button" class="ss-row" data-ss="slack-monitor-review" ${disabled}><span class="ss-label ss-accent">Review and start watching</span></button>
                <button type="button" class="ss-row" data-ss="slack-monitor-cancel" ${disabled}><span class="ss-label">Cancel</span></button></div>
            <p class="ss-foot">nenva checks while it is running on this Mac, from today on.</p>`;
    },
    /** The search box narrows the rows in place; no re-render, focus stays. */
    filterPicker(input) {
        if (!this._setup) return;
        this._setup.query = input.value;
        const q = input.value.toLowerCase().trim();
        const scope = input.closest('.ss-wrap') || document;
        scope.querySelectorAll('[data-slack-name]').forEach(r => { r.hidden = !!q && !r.dataset.slackName.includes(q); });
    },
    monitoringChange(target) {
        if (!this._setup) return;
        if (target.dataset.slackConversation) {
            const id = target.dataset.slackConversation;
            if (target.checked && this._setup.selected.size >= 20) { target.checked = false; this._monitorError = 'Choose up to 20 conversations.'; this._changed(); return; }
            if (target.checked) this._setup.selected.add(id); else this._setup.selected.delete(id);
            const count = (target.closest('.ss-wrap') || target.ownerDocument).querySelector('[data-slack-count]');
            if (count) count.textContent = `${this._setup.selected.size} of 20 chosen`;
        }
        if (target.matches('[data-slack-model]')) this._setup.modelId = target.value;
    },
    async monitoringAction(action) {
        const api = window.electronSlackMonitor;
        if (!api || this._monitorBusy) return;
        this._monitorBusy = true; this._monitorError = ''; this._changed();
        try {
            let result;
            if (action === 'review-morning') {
                await this.addReview();
            } else if (action === 'setup') {
                result = await api.begin(this.server()?.name);
                if (!result.error) this._setup = { ...result, selected: new Set(this._monitor?.scope?.conversationIds || []), modelId: '', query: '' };
            } else if (action === 'more' && this._setup) {
                result = await api.more(this._setup.session);
                if (!result.error) Object.assign(this._setup, result);
            } else if (action === 'review' && this._setup) {
                const model = this._setupModel();
                if (!this._setup.selected.size) throw new Error('Choose at least one conversation.');
                if (!model) throw new Error('Choose a model to read with.');
                result = await api.review({ session: this._setup.session, conversationIds: [...this._setup.selected], modelId: model.id });
                if (!result.error && !result.cancelled) this._setup = null;
            } else if (action === 'cancel') { result = await api.cancel(); this._setup = null; }
            else if (['pause', 'resume', 'stop'].includes(action)) result = await api.control(action);
            if (result?.error) throw new Error(result.code === 'setup_expired' ? 'That took a while, so nenva let it go. Choose conversations again.' : result.error);
        } catch (error) { this._monitorError = error.message; }
        finally { this._monitorBusy = false; await this.refresh(); }
    },
    /** ONE morning review per approved scope (was three preset buttons);
     * narrowing it is a conversation in its own chat. */
    _reviewRoutine() {
        const scope = this._monitor?.scope;
        if (!scope || typeof NotePrompts === 'undefined') return null;
        return NotePrompts.list().find(r => {
            const w = NotePrompts.config(r).slackWatch;
            return w && w.workspaceId === scope.workspaceId && w.userId === scope.userId;
        }) || null;
    },
    async addReview() {
        const scope = this._monitor?.scope;
        if (!scope || typeof NotePrompts === 'undefined') throw new Error('Choose conversations first.');
        const existing = this._reviewRoutine();
        if (existing) { if (typeof PromptsApp !== 'undefined') PromptsApp.open({ id: existing.id }); return; }
        const machineId = await RoutineEngine._loadMachineId();
        if (!machineId) throw new Error('Could not identify this Mac. Try again.');
        const watch = { ...scope, kinds: ['request', 'commitment', 'change', 'blocker'], since: Date.now() };
        const routine = NotePrompts.create({ title: 'Slack morning review',
            body: 'Review new, meaningful findings in the selected Slack conversations: requests and commitments, decisions that changed, and blockers. Stay quiet when nothing has changed.',
            config: { offline: true, interval: 'daily', time: '08:00', homeMachineId: machineId,
                runMode: 'digest', useContext: false, web: false, slackWatch: watch } });
        if (typeof PromptsApp !== 'undefined') PromptsApp.open({ id: routine.id });
    },
    routineOwns(matter) {
        if (!this._monitor?.running || this._monitor.paused || typeof NotePrompts === 'undefined') return false;
        return NotePrompts.list().some(r => {
            const cfg = NotePrompts.config(r), w = cfg.slackWatch;
            if (!cfg.offline || !w || cfg.homeMachineId !== RoutineEngine._machineId) return false;
            const approved = this._monitor.scope;
            if (!approved || w.workspaceId !== approved.workspaceId || w.userId !== approved.userId
                || !Array.isArray(w.conversationIds) || w.conversationIds.some(id => !approved.conversationIds.includes(id))
                || matter.slackScopes?.some(s => s.workspaceId !== w.workspaceId || s.userId !== w.userId
                    || !w.conversationIds.includes(s.channelId))) return false;
            return (matter.sources || []).some(s => s.slack && !s.slack.invalidated && s.tell === 'morning'
                && Date.parse(s.filedAt || s.at) >= w.since && w.workspaceId === s.slack.workspaceId && w.userId === s.slack.userId
                && w.conversationIds?.includes(s.slack.channelId) && w.kinds?.includes(s.slack.kind))
                && matter.sources?.at(-1)?.tell !== 'now';
        });
    },
    async connect() {
        if (this._busy || !window.electronMCP || typeof SettingsApp === 'undefined') return;
        this._busy = true; this._error = ''; this._changed();
        try {
            await this.refresh();
            if (this._readError) return;
            let server = this.server();
            if (!server) {
                // Reuse any existing Slack connection; never replace a user's
                // differently configured server just because it has this name.
                let name = 'slack', suffix = 2;
                while (this._servers.some(s => s.name === name)) name = `slack-${suffix++}`;
                const added = await window.electronMCP.addServer({ name, url: this.URL, auth: 'oauth' });
                if (added.error) throw new Error(added.error);
                server = { name: added.name };
            } else if (!server.enabled) {
                const enabled = await window.electronMCP.setEnabled(server.name, true);
                if (enabled.error) throw new Error(enabled.error);
            }
            const result = await SettingsApp._connectMCPServer(server.name, { label: 'Slack' });
            if (result?.error) this._error = result.error;
        } catch (e) { this._error = e.message || 'Could not connect to Slack. Try again.'; }
        finally { this._busy = false; await this.refresh(); }
    },
    async disconnect() {
        this._error = '';
        try {
            // Disconnect every Slack connection so the simple page cannot say
            // "disconnected" while a duplicate still grants access.
            const servers = await window.electronMCP.listServers();
            for (const server of servers.filter(s => this.matches(s))) {
                const result = await window.electronMCP.disconnectServer(server.name);
                if (result.error) throw new Error(result.error);
                if (typeof MCPTools !== 'undefined') MCPTools.unregisterServer(server.name);
            }
        } catch (e) { this._error = e.message || 'Could not disconnect. Try again.'; }
        await this.refresh();
    },
    async cancel() {
        try {
            const server = this.server();
            if (server) {
                const result = await window.electronMCP.cancelAuthorization(server.name);
                if (result.error) throw new Error(result.error);
            }
        } catch (e) { this._error = e.message || 'Could not cancel sign-in. Try again.'; }
        await this.refresh();
    },
    init() {
        if (typeof FEATURES !== 'undefined' && (!FEATURES.isEnabled('mcp') || !FEATURES.isEnabled('slack'))) return;
        if (typeof Sources !== 'undefined') Sources.register({
            id: 'slack', label: 'Slack', icon: 'text', iconAsset: 'slack.png', kind: 'texts', mode: 'reference', writesBack: true,
            words: 'workspace channels conversations messages threads team chat',
            reads: 'Slack conversations you ask nenva to read, and messages you ask it to send. Optional monitoring reads only conversations you select, using the model you approve. Bounded excerpts stay queued on this Mac; derived findings join your insights.',
            status: () => this.status(), page: S => S._slackHtml()
        });
        window.electronMCP?.onServersChanged?.(() => this.refresh());
        window.electronSlackMonitor?.onChanged?.(() => this.refresh());
        this.refresh();
    }
};
SlackConnector.init();
