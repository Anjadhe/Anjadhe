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
        const on = !!(server?.enabled && server.authStatus === 'connected');
        const connecting = server?.authStatus === 'connecting';
        const error = this._error || this._readError;
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
    monitoringHtml(esc) {
        const status = this._monitor;
        if (!status?.available && !status?.configured) return '';
        const disabled = this._monitorBusy ? 'disabled' : '';
        const error = this._monitorError ? `<p class="ss-foot ss-error" role="alert">${esc(this._monitorError)}</p>` : '';
        if (this._setup && status.available) {
            const setup = this._setup;
            const rows = setup.conversations.map(c => `<label class="ss-row ss-two"><span class="ss-pick-copy"><span class="ss-label">${esc(c.name || c.peerId || c.id)}</span><span class="ss-sub">${esc(c.type === 'im' ? 'Direct message' : c.type === 'mpim' ? 'Group message' : 'Channel')} · ${esc(c.id)}</span></span><input type="checkbox" data-slack-conversation="${esc(c.id)}" ${setup.selected.has(c.id) ? 'checked' : ''} ${disabled}></label>`).join('');
            return `<h3 class="ss-monitor-title">Choose what matters</h3><p class="ss-lede">Choose up to 20 conversations in ${esc(setup.workspaceName || setup.workspaceId)}. Look for requests that need you, commitments, and decisions affecting your work.</p>
                <div class="ss-group">${rows || '<p class="ss-row">No conversations found.</p>'}</div>
                ${setup.more ? `<button type="button" class="ss-row" data-ss="slack-monitor-more" ${disabled}>Show more conversations</button>` : ''}
                <label class="ss-row"><span class="ss-label">Analyze with</span><select class="ss-select" data-slack-model ${disabled}><option value="">Choose a model</option>${setup.models.map(m => `<option value="${esc(m.id)}" ${setup.modelId === m.id ? 'selected' : ''}>${esc(m.label)} · ${m.engine === 'llamacpp' ? 'On this Mac' : 'Leaves this Mac'}</option>`).join('')}</select></label>
                <p class="ss-foot">Checks start from activation. Review the exact scope and where selected excerpts go before enabling. Monitoring creates no routines.</p>
                <button type="button" class="ss-row" data-ss="slack-monitor-review" ${disabled}>Review and enable</button>
                <button type="button" class="ss-row" data-ss="slack-monitor-cancel" ${disabled}>Cancel</button>${error}`;
        }
        const problems = { analysis_limit: 'Paused at analysis limit', model_changed: 'Review your analysis model', privacy_blocked: 'Review data permissions', cloud_policy_unavailable: 'Cloud monitoring safeguards are not available yet', deferred: 'Some messages exceed the analysis limits', analyzing: 'Analyzing', analysis_failed: 'Analysis will retry', budget_unavailable: 'Usage tracking needs attention' };
        const label = !status.available ? 'Monitoring unavailable' : status.outcome === 'needs_sign_in' ? 'Needs sign-in'
            : status.paused ? 'Paused' : status.running === false ? 'Waiting to resume'
                : problems[status.analysisState] || (status.analysisState && status.analysisState !== 'ready' ? 'Analysis needs attention'
                    : status.outcome === 'store_unavailable' ? 'Needs attention' : status.pending || status.channels?.some(c => c.error) ? 'Partially checked' : 'Watching');
        const date = value => value ? esc(new Date(value).toLocaleString()) : 'Not yet';
        return `<h3 class="ss-monitor-title">Focus on what matters</h3><p class="ss-lede">Find requests that need you, commitments to follow through on, and decisions affecting your work.</p>
            <div class="ss-group">${status.configured ? `<div class="ss-row" role="status">${label} · ${Number(status.pending) || 0} messages waiting</div>
                <p class="ss-foot">Last analysis: ${date(status.lastAnalysisAt)}. ${status.usage?.unavailable ? 'Usage tracking is unavailable; analysis cannot proceed.' : `${Number(status.usage?.requestsToday) || 0} of ${Number(status.usage?.requestLimit) || 60} analysis requests used in the past 24 hours.`} Coverage may be incomplete.</p>
                <p class="ss-foot">Last Slack read: ${date(status.lastReadAt)}. ${status.channels?.filter(c => c.error).length || 0} conversations need another check.</p>
                ${status.analysisNextAt > Date.now() ? `<p class="ss-foot">Next analysis attempt: ${date(status.analysisNextAt)}.</p>` : ''}
                ${status.available || !status.paused ? `<button type="button" class="ss-row" data-ss="slack-monitor-${status.paused ? 'resume' : 'pause'}" ${disabled}>${status.paused ? 'Resume' : 'Pause'} monitoring</button>` : ''}
                <button type="button" class="ss-row" data-ss="slack-monitor-stop" ${disabled}>Stop monitoring</button>` : ''}
                ${status.available ? `<button type="button" class="ss-row" data-ss="slack-monitor-setup" ${disabled}>${status.configured ? 'Review scope and model' : 'Set up monitoring'}</button>` : ''}</div>
            ${status.available && status.configured ? `<h3 class="ss-monitor-title">Optional morning reviews</h3><p class="ss-foot">At 08:00 on this Mac, collect new findings from your selected conversations in a Standing chat. For example: “The launch review needs your response.” Urgent findings stay in Now. No additional Slack reads or AI analysis.</p><div class="ss-group">
                <button type="button" class="ss-row" data-ss="slack-monitor-review-requests" ${disabled}>Add a review of requests and commitments</button>
                <button type="button" class="ss-row" data-ss="slack-monitor-review-changes" ${disabled}>Add a review of changed decisions</button>
                <button type="button" class="ss-row" data-ss="slack-monitor-review-blockers" ${disabled}>Add a review of blockers</button></div>` : ''}${error}`;
    },
    monitoringChange(target) {
        if (!this._setup) return;
        if (target.dataset.slackConversation) {
            const id = target.dataset.slackConversation;
            if (target.checked && this._setup.selected.size >= 20) { target.checked = false; this._monitorError = 'Choose up to 20 conversations.'; this._changed(); return; }
            if (target.checked) this._setup.selected.add(id); else this._setup.selected.delete(id);
        }
        if (target.matches('[data-slack-model]')) this._setup.modelId = target.value;
    },
    async monitoringAction(action) {
        const api = window.electronSlackMonitor;
        if (!api || this._monitorBusy) return;
        this._monitorBusy = true; this._monitorError = ''; this._changed();
        try {
            let result;
            if (action.startsWith('review-')) {
                await this.addReview(action.slice(7));
            } else if (action === 'setup') {
                result = await api.begin(this.server()?.name);
                if (!result.error) this._setup = { ...result, selected: new Set(), modelId: '' };
            } else if (action === 'more' && this._setup) {
                result = await api.more(this._setup.session);
                if (!result.error) Object.assign(this._setup, result);
            } else if (action === 'review' && this._setup) {
                if (!this._setup.selected.size || !this._setup.modelId) throw new Error('Choose conversations and an AI model first.');
                result = await api.review({ session: this._setup.session, conversationIds: [...this._setup.selected], modelId: this._setup.modelId });
                if (!result.error && !result.cancelled) this._setup = null;
            } else if (action === 'cancel') { result = await api.cancel(); this._setup = null; }
            else if (['pause', 'resume', 'stop'].includes(action)) result = await api.control(action);
            if (result?.error) throw new Error(result.code === 'setup_expired' ? 'Setup expired. Open setup again.' : result.error);
        } catch (error) { this._monitorError = error.message; }
        finally { this._monitorBusy = false; await this.refresh(); }
    },
    async addReview(kind) {
        const choices = { requests: { title: 'Slack requests and commitments', kinds: ['request', 'commitment'] },
            changes: { title: 'Slack decisions that changed', kinds: ['change'] }, blockers: { title: 'Slack blockers', kinds: ['blocker'] } };
        const choice = choices[kind], scope = this._monitor?.scope;
        if (!choice || !scope || typeof NotePrompts === 'undefined') throw new Error('Set up monitoring first.');
        const machineId = await RoutineEngine._loadMachineId();
        if (!machineId) throw new Error('Could not identify this Mac. Try again.');
        const signature = w => JSON.stringify([w?.workspaceId, w?.userId, w?.conversationIds, w?.kinds]);
        const watch = { ...scope, kinds: choice.kinds, since: Date.now() };
        const existing = NotePrompts.list().find(r => signature(NotePrompts.config(r).slackWatch) === signature(watch));
        const routine = existing || NotePrompts.create({ title: choice.title,
            body: 'Review new, meaningful findings in the selected Slack conversations. Stay quiet when nothing has changed.',
            config: { offline: true, interval: 'daily', time: '08:00', homeMachineId: machineId,
                runMode: 'digest', useContext: false, web: false, slackWatch: watch } });
        if (existing) NotePrompts.update(existing.id, { config: { offline: true } });
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
        if (typeof FEATURES !== 'undefined' && !FEATURES.isEnabled('mcp')) return;
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
