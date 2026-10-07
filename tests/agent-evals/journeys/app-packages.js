/**
 * App packages (docs/PLATFORM.md "App packages: one container, two trust
 * tiers", 2026-08-29): a built-in loads from its own folder (listed in
 * js/apps/bundled.json) and registers everything the assistant knows about
 * it from there. The Wellness-specific checks went with that package
 * (folded into commitments 2026-10-05); what is pinned here is the
 * registry seams a package reaches through.
 */
module.exports = [
  {
    id: 'pkg-record-links-registrable',
    name: 'RecordLinks.register adds a linkable type and it reaches the prompt grammar',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        let opened = null;
        const ok = RecordLinks.register('plant', { label: 'plant', hint: 'a houseplant', exists: (id) => id === 'p1', open: (id) => { opened = id; } });
        const inTable = ok && RecordLinks.TYPES.plant?.label === 'plant';
        const grammar = RecordLinks.promptTypes();
        const inPrompt = /\bplant \(a houseplant\)/.test(grammar) && /^task, event \(calendar\), note/.test(grammar);
        const parsed = RecordLinks.parse('anjadhe://plant/p1');
        const parses = !!parsed && parsed.type === 'plant' && parsed.id === 'p1';
        RecordLinks.open('plant', 'p1');
        const opens = opened === 'p1';
        // The assembled system prompt carries the live grammar, placeholder resolved.
        const msgs = AgentService.buildSystemMessages(null, { pristine: true });
        const sys = msgs.map(m => m.content || '').join('\n');
        const assembled = sys.includes('plant (a houseplant)') && !sys.includes('{{RECORD_LINK_TYPES}}');
        RecordLinks.unregister('plant');
        const removed = !RecordLinks.TYPES.plant && !/plant/.test(RecordLinks.promptTypes());
        const pass = inTable && inPrompt && parses && opens && removed && assembled;
        return { pass, detail: JSON.stringify({ inTable, inPrompt, parses, opens, assembled, removed }) };
      });
    }
  },
  {
    id: 'pkg-widget-data-shape-for-user-apps',
    name: 'A user app widget returns data; the host paints it escaped and drops empty ones',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const empty = Widgets.fromData(null) === null && Widgets.fromData({ rows: [] }) === null;
        const painted = Widgets.fromData({ rows: [{ sub: '9:00', text: '<b>Fern</b>', flag: 'dry', actions: [{ action: 'water', id: 'p1', label: 'Watered' }] }], more: 2, count: 3, tone: 'warn', footer: 'x<y' });
        const escaped = !!painted && painted.body.includes('&lt;b&gt;Fern&lt;/b&gt;') && !painted.body.includes('<b>Fern')
          && painted.body.includes('data-w-action="water"') && painted.body.includes('+2 more')
          && painted.count === 3 && painted.tone === 'warn' && painted.footer === 'x&lt;y';
        const badTone = !('tone' in (Widgets.fromData({ rows: [{ text: 'a' }], tone: 'purple' }) || {}));
        let acted = null;
        const wid = Anjadhe.registerWidgetFor('plant-tracker', {
          title: 'Plants', order: 40,
          load: () => ({ rows: [{ text: 'Fern', actions: [{ action: 'water', id: 'p1', label: 'Watered' }] }] }),
          onAction: (action, data) => { acted = action + ':' + data.id; }
        });
        const def = Widgets._defs.find(d => d.id === wid);
        const registered = wid === 'userapp-plant-tracker' && def?.app === 'plant-tracker' && def.kind === 'attention';
        const loaded = await def.load();
        const loads = !!loaded && loaded.body.includes('Fern');
        def.onAction('water', { id: 'p1' });
        const acts = acted === 'water:p1';
        Widgets.unregister(wid);
        const gone = !Widgets._defs.some(d => d.id === wid);
        const pass = empty && escaped && badTone && registered && loads && acts && gone;
        return { pass, detail: JSON.stringify({ empty, escaped, badTone, registered, loads, acts, gone }) };
      });
    }
  },
  {
    id: 'pkg-registry-keeps-every-builtin-tile',
    name: 'Packaging never drops a built-in from the registry (tile audit)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const expected = ['agent','actions','goals','email','fyi','notes','prompts','reader','portfolio','settings','aiactivity','help','about'];
        const ids = new Set(GlobalSearch.allApps().map(a => a.id));
        // Feature-gated apps (Maker) are dropped by allApps when the flag is off; check the DOM for them.
        const dom = new Set([...document.querySelectorAll('#app-registry .dash-apps-section .dash-app-tile[data-app]')].map(t => t.dataset.app));
        const missing = expected.filter(id => !ids.has(id) && !dom.has(id));
        return { pass: missing.length === 0, detail: JSON.stringify({ missing, count: dom.size }) };
      });
    }
  },
  {
    id: 'pkg-bundled-portfolio-loaded-from-folder',
    name: 'Portfolio loads from its package (labelled Finance since 2026-10-05): six views, Money tile, widget, resolver domains',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const manifest = (BundledApps._loaded || []).find(m => m.id === 'portfolio');
        const views = ['portfolio','portfolio-ticker','portfolio-property','portfolio-liability','portfolio-transaction','portfolio-snapshots']
          .every(id => !!document.querySelector(`#app-views > #${id}-view.view`));
        const tile = document.querySelector('#app-registry .dash-apps-section .dash-app-tile[data-app="portfolio"]');
        const inGroup = !!tile && tile.closest('.dash-apps-group')?.querySelector('.dash-apps-group-label')?.textContent.trim() === 'Money';
        // The person sees ONE app, Finance (CLAUDE.md "Finance = Portfolio + Spending"); ids stay portfolio.
        const launcher = GlobalSearch.launcherApps().some(a => a.id === 'portfolio' && a.title === 'Finance');
        const label = Breadcrumb.appLabels.portfolio === 'Finance';
        const registered = AppManager.apps.portfolio === PortfolioApp;
        const widget = Widgets._defs.some(d => d.id === 'portfolio' && d.kind === 'glance');
        const domains = (AgentContext.recordDomains('portfolio') || []).includes('portfolio');
        const merged = (WriteLedger.RECORD_MERGED_ARRAYS.portfolio || []).includes('transactions');
        const pass = !!manifest && views && inGroup && launcher && label && registered && widget && domains && merged;
        return { pass, detail: JSON.stringify({ manifest: !!manifest, views, inGroup, launcher, label, registered, widget, domains, merged }) };
      });
    }
  },
  {
    id: 'pkg-portfolio-api-for-other-packages',
    name: 'Email reaches the portfolio only through Anjadhe.use("portfolio")',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const P = Anjadhe.use('portfolio');
        const exposed = !!P && ['accounts','transactions','buildOccSymbol','addTransactions'].every(k => typeof P[k] === 'function');
        const occ = P.buildOccSymbol('AAPL', '2026-12-18', 'call', 250);
        const symbol = /^AAPL\d{6}C\d{8}$/.test(occ);
        const noReach = !/PortfolioApp/.test(String(EmailApp.hasTransactionFromEmail) + String(EmailApp.txnAddedAccountNames) + String(EmailApp.showTransactionConfirmModal));
        const pass = exposed && symbol && noReach;
        return { pass, detail: JSON.stringify({ exposed, symbol, occ, noReach }) };
      });
    }
  },
  {
    id: 'pkg-record-types-one-table',
    name: 'Record types: @-mention, decisions, banner label and open door all read RecordTypes',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const types = RecordTypes.all().map(d => d.type);
        const seeded = ['goal','task','note','routine','strategy','account','ticker'].every(t => types.includes(t));
        const decisionTypes = DecisionStore.TYPES;
        // ticker became a decision host 2026-09-03 (correct_ticker_profile saves a note on the symbol).
        const decisions = ['task','goal','note','routine','strategy','account','ticker'].every(t => decisionTypes.includes(t));
        const words = RecordMention.TYPE_WORDS;
        const mention = words.strategies === 'Strategy' && words.account === 'Account'
          && words.goal === 'Project' && words.project === 'Project';
        const label = AgentUI._recordTypeLabel('portfolio:strategy:x') === 'Strategy'
          && AgentUI._recordTypeLabel('portfolio:ticker:AAPL') === 'Ticker'
          && AgentUI._recordTypeLabel('schedule:1') === 'Task'
          && AgentUI._recordTypeLabel('portfolio:overview') === 'Record';
        const keys = RecordTypes.recordKey('account', 'a1') === 'portfolio:account:a1'
          && DecisionStore.fromRecordKey('portfolio:strategy:s1') === 'strategy:s1'
          && DecisionStore.fromRecordKey('portfolio:ticker:AAPL') === 'ticker:AAPL'
          && DecisionStore.fromRecordKey('goals:g1') === 'goal:g1';
        const en = AgentTools.definitions.find(d => d.function.name === 'save_decision').function.parameters.properties.type.enum;
        const enumOk = ['strategy','account','task','ticker'].every(t => en.includes(t));
        // resolveKey through the registry: a strategy by name.
        const saved = PortfolioStrategy.save({ name: 'Pkg Test Plan', objective: 'test' });
        const r = DecisionStore.resolveKey('strategy', { name: 'Pkg Test Plan' });
        const resolves = r.key === `strategy:${saved.id}` && r.recordTitle === 'Pkg Test Plan';
        const tickerKey = DecisionStore.resolveKey('ticker', { id: 'aapl' });
        const bad = tickerKey.key === 'ticker:AAPL' && !!DecisionStore.resolveKey('ticker', { id: '__CASH__' }).error && !!DecisionStore.resolveKey('task', {}).error;
        const mentioned = RecordMention._index().some(it => it.key === `portfolio:strategy:${saved.id}` && it.type === 'Strategy');
        PortfolioStrategy.remove(saved.id);
        // Links registry
        const links = LinkManager.linkableApps().includes('portfolio')
          && LinkPicker.appLabels.portfolio === 'Account' && LinkPicker.appLabelsPlural.portfolio === 'Accounts'
          && LinkManager.getItemMeta('portfolio', 'overview')?.overview === true
          && LinkManager.getAppItems('portfolio')[0]?.id === 'overview';
        const pass = seeded && decisions && mention && label && keys && enumOk && resolves && bad && mentioned && links;
        return { pass, detail: JSON.stringify({ seeded, decisions, mention, label, keys, enumOk, resolves, bad, mentioned, links }) };
      });
    }
  },
  {
    id: 'pkg-starter-and-suggestion-seams',
    name: 'A package registers its quick-start pill; no routine is seeded on install',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        // Starter routines were removed 2026-10-05: nothing is armed unasked.
        const noStarters = typeof StarterPrompts === 'undefined'
          && !NotePrompts._readNotes().some(n => /^starter-/.test(n.id || ''));
        const pill = AgentUI.GENERAL_SUGGESTIONS.some(s => s.text === 'How is my portfolio doing?');
        const noDup = AgentUI.registerSuggestion({ text: 'How is my portfolio doing?' }) === true
          && AgentUI.GENERAL_SUGGESTIONS.filter(s => s.text === 'How is my portfolio doing?').length === 1;
        const pass = noStarters && pill && noDup;
        return { pass, detail: JSON.stringify({ noStarters, pill, noDup }) };
      });
    }
  },
  {
    id: 'pkg-sandbox-use-bridge',
    name: 'A sandboxed user app acts on a bundled package through anjadhe.use() — allowlisted by its manifest',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const dir = 'pkg-bridge-probe';
        const apps = window.electronApps;
        if (!apps?.writeFile) return { pass: false, detail: 'no electronApps bridge' };
        await apps.enable();
        const manifest = { manifestVersion: 1, id: dir, name: 'Bridge Probe', icon: '&#9670;', uses: ['schedule'], keywords: ['bridgeprobe'] };
        const appJs = `
Anjadhe.registerApp({
  init() {
    anjadhe.registerTool({ type: 'function', function: { name: 'pkg_bridge_probe', description: 'probe', parameters: { type: 'object', properties: {} } } },
      async () => {
        const S = anjadhe.use('schedule');
        if (!S) return { installed: false };
        const id = await S.createTask({ title: 'Bridge probe task', scheduledDate: '2031-01-01' });
        const t = await S.getTask(id);
        let denied = null;
        try { anjadhe.use('portfolio'); } catch (e) { denied = e.message; }
        return { installed: true, id, title: t && t.title, isPromise: typeof S.getTask(id).then === 'function', denied };
      });
  },
  render() { document.getElementById('${dir}-view').textContent = 'probe'; }
});`;
        await apps.writeFile(dir, 'manifest.json', JSON.stringify(manifest));
        await apps.writeFile(dir, 'app.js', appJs);
        // The folder watcher (400ms debounce) mounts it; wait for the guest to register its tool.
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && typeof AgentTools.handlers.pkg_bridge_probe !== 'function') await new Promise(r => setTimeout(r, 150));
        const mounted = typeof AgentTools.handlers.pkg_bridge_probe === 'function' && AgentManagerSandboxed();
        function AgentManagerSandboxed() { return !!document.querySelector(`iframe#${dir}-view`); }
        let r = null, err = null;
        try { r = mounted ? await AgentTools.handlers.pkg_bridge_probe({}) : null; } catch (e) { err = e.message; }
        const bridged = !!r && r.installed === true && r.title === 'Bridge probe task' && r.isPromise === true;
        const allowlisted = !!r && /uses:\["portfolio"\]/.test(String(r.denied || ''));
        const landed = !!r && ScheduleApp.scheduleItems.some(t => t.id === r.id && t.scheduledDate === '2031-01-01');
        // Host-side enforcement too: a forged use-call for an undeclared api is refused.
        const rec = UserAppSandbox._records[dir];
        let hostDenied = false;
        if (rec) {
          const orig = UserAppSandbox._post.bind(UserAppSandbox);
          let captured = null;
          UserAppSandbox._post = (id, msg) => { if (msg.type === 'use-result') captured = msg; };
          await UserAppSandbox._useCall(rec, { callId: 'x', api: 'portfolio', method: 'accounts', args: [] });
          UserAppSandbox._post = orig;
          hostDenied = !!captured?.error && /not declared/.test(captured.error);
        }
        if (r?.id) ScheduleApp.deleteTask(r.id);
        await apps.deleteFolder(dir);
        const pass = mounted && bridged && allowlisted && landed && hostDenied;
        return { pass, detail: JSON.stringify({ mounted, bridged, allowlisted, landed, hostDenied, err, r }) };
      });
    }
  }
];
