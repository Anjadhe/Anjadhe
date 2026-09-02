/**
 * App packages (docs/PLATFORM.md "App packages: one container, two trust
 * tiers", 2026-08-29). Wellness is the first built-in that loads from its
 * own folder (js/apps/wellness/, listed in js/apps/bundled.json) and
 * registers everything the assistant knows about it from there. Pinned:
 *  - the loader delivered the view, the registry tile, the breadcrumb
 *    label and the default-hidden seed — index.html names none of them.
 *  - the package's registrations landed in every table the agent stack
 *    reads: tool group + domain vocabulary, ask policy, untrusted block,
 *    consent line, record pill label, cloud-privacy class, search source.
 *  - unregisterBySource reverses all of it (the hot-reload contract), and
 *    a re-registration restores it.
 */
module.exports = [
  {
    id: 'pkg-bundled-wellness-loaded-from-folder',
    name: 'Wellness view, tile, label and hidden seed come from its package',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const manifest = (BundledApps._loaded || []).find(m => m.id === 'wellness');
        const view = !!document.querySelector('#app-views > #wellness-view.view.app-view');
        const tile = document.querySelector('#app-registry .dash-apps-section .dash-app-tile[data-app="wellness"]');
        const inGroup = !!tile && tile.closest('.dash-apps-group')?.querySelector('.dash-apps-group-label')?.textContent.trim() === 'Health';
        const desc = !!tile && /health log/i.test(tile.dataset.desc || '');
        const styled = !!document.querySelector('link[rel="stylesheet"][href$="js/apps/wellness/wellness.css"]');
        const label = Breadcrumb.appLabels.wellness === 'Wellness';
        const hidden = AppManager.DEFAULT_HIDDEN_APPS.includes('wellness');
        const registered = AppManager.apps.wellness === WellnessApp;
        const launcher = GlobalSearch.allApps().some(a => a.id === 'wellness' && a.title === 'Wellness' && a.group === 'Health');
        const pass = !!manifest && view && inGroup && desc && styled && label && hidden && registered && launcher;
        return { pass, detail: JSON.stringify({ manifest: !!manifest, view, inGroup, desc, styled, label, hidden, registered, launcher }) };
      });
    }
  },
  {
    id: 'pkg-registrations-land-in-every-table',
    name: 'A package registers tools + policy into the tables the agent stack reads',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const names = ['log_wellness', 'update_wellness', 'delete_wellness', 'list_wellness', 'wellness_summary'];
        const tools = names.every(n => typeof AgentTools.handlers[n] === 'function'
          && AgentTools.definitions.some(d => d.function.name === n)
          && AgentTools._toolGroups[n] === 'wellness'
          && AgentTools._dynamicTools[n]?.source === 'wellness');
        const domain = AgentTools._domainsForMessage('how was my blood pressure this week').has('wellness')
          // Plain activity talk must summon the group — no workout/exercise
          // word, no medical noun (2026-08-31 miss: "went for a walk" shipped
          // no wellness tools, so nothing could log it).
          && AgentTools._domainsForMessage('i went for a walk last night for 2 miles').has('wellness')
          && AgentTools._domainsForMessage('ran 5k this morning').has('wellness')
          && AgentTools._domainsForMessage('did 30 minutes of yoga').has('wellness')
          && !AgentTools._domainsForMessage('rename my note').has('wellness');
        const ask = PermissionManager.resolve('delete_wellness', { id: 'x' }).decision === 'ask'
          && PermissionManager.ASK_TOOLS.has('delete_wellness')
          && PermissionManager.resolve('log_wellness', { kind: 'water' }).decision === 'allow';
        const untrusted = ['list_wellness', 'wellness_summary', 'update_wellness', 'delete_wellness']
          .every(n => AgentService.UNTRUSTED_BLOCKED_TOOLS.has(n))
          && !AgentService.UNTRUSTED_BLOCKED_TOOLS.has('log_wellness');
        const describe = /Delete the wellness entry/.test(AgentUI._describeToolAction('delete_wellness', { id: 'nope' }));
        const ledger = WriteLedger.RECORD_TOOLS.log_wellness?.[0] === 'wellness'
          && AgentTools._recordLabels.wellness === 'Wellness';
        const privacy = CloudPrivacy.TOOL_CLASS.list_wellness === 'wellness'
          && CloudPrivacy.TOOL_CLASS.wellness_summary === 'wellness'
          && !CloudPrivacy.TOOL_CLASS.log_wellness;
        const search = !!GlobalSearch._sources.wellness && GlobalSearch.appLabel('wellness') === 'Wellness';
        const pass = tools && domain && ask && untrusted && describe && ledger && privacy && search;
        return { pass, detail: JSON.stringify({ tools, domain, ask, untrusted, describe, ledger, privacy, search }) };
      });
    }
  },
  {
    id: 'pkg-unregister-reverses-every-row',
    name: 'unregisterBySource removes every table row a package wrote; re-registering restores it',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const n = AgentTools.unregisterBySource('wellness');
        const gone = n === 5
          && !AgentTools.handlers.list_wellness
          && !AgentTools._toolGroups.delete_wellness
          && !AgentTools._dynamicDomainRes.wellness
          && !PermissionManager.ASK_TOOLS.has('delete_wellness')
          && !AgentService.UNTRUSTED_BLOCKED_TOOLS.has('list_wellness')
          && !WriteLedger.RECORD_TOOLS.log_wellness
          && !CloudPrivacy.TOOL_CLASS.list_wellness
          && !AgentTools._domainsForMessage('my blood pressure').has('wellness');
        // Re-run the package's assistant contribution the way the loader does.
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'js/apps/wellness/wellness-tools.js?reload=' + Date.now();
          s.onload = resolve; s.onerror = reject;
          document.body.appendChild(s);
        });
        const back = typeof AgentTools.handlers.list_wellness === 'function'
          && PermissionManager.ASK_TOOLS.has('delete_wellness')
          && AgentService.UNTRUSTED_BLOCKED_TOOLS.has('list_wellness')
          && AgentTools._domainsForMessage('my blood pressure').has('wellness');
        const pass = gone && back;
        return { pass, detail: JSON.stringify({ n, gone, back }) };
      });
    }
  },
  {
    id: 'pkg-bundled-pomodoro-subapp-eager',
    name: 'Pomodoro loads from its package as a sub-app of Tasks with eager init',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const manifest = (BundledApps._loaded || []).find(m => m.id === 'pomodoro');
        const view = !!document.querySelector('#app-views > #pomodoro-view.view.app-view');
        const tile = document.querySelector('#app-registry .dash-apps-section .dash-app-tile[data-app="pomodoro"]');
        const subapp = !!tile && tile.dataset.subappOf === 'actions';
        const inRegistry = GlobalSearch.allApps().some(a => a.id === 'pomodoro' && a.subappOf === 'actions');
        const notInLauncher = !GlobalSearch.launcherApps().some(a => a.id === 'pomodoro');
        const label = Breadcrumb.appLabels.pomodoro === 'Pomodoro';
        const eager = AppManager.apps.pomodoro === PomodoroApp && PomodoroApp._initialized === true;
        const quotes = typeof QuotesLibrary !== 'undefined' && QuotesLibrary.search('').length > 0;
        const noReach = !/ScheduleApp/.test(String(PomodoroApp.startForTask) + String(PomodoroApp._ensureLinkedTask) + String(PomodoroApp._setTaskTimer));
        const pass = !!manifest && view && subapp && inRegistry && notInLauncher && label && eager && quotes && noReach;
        return { pass, detail: JSON.stringify({ manifest: !!manifest, view, subapp, inRegistry, notInLauncher, label, eager, quotes, noReach }) };
      });
    }
  },
  {
    id: 'pkg-cross-app-seam-schedule-focus',
    name: 'Packages act on each other only through Anjadhe.expose/use',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const S = Anjadhe.use('schedule');
        const F = Anjadhe.use('focusTimer');
        const exposed = !!S && !!F && Anjadhe.use('no-such-api') === null;
        // Schedule API round trip: create → read → timer → retroactive stop → complete.
        const id = S.createTask('pkg seam test');
        const created = !!id && S.getTask(id)?.title === 'pkg seam test' && S.todayTasks().some(t => t.id === id);
        S.startTimer(id);
        const running = !!S.getTask(id).timerStartedAt;
        S.stopTimerAt(id, Date.now() + 60_000);
        const raw = ScheduleApp.scheduleItems.find(i => i.id === id);
        const stopped = !raw.timerStartedAt && raw.totalTimeSpent >= 59_000;
        // Pomodoro links to the task through the same API (no ScheduleApp reach).
        PomodoroApp.startForTask(id);
        const linked = PomodoroApp.linkedTaskId === id && PomodoroApp.isRunning && F.isFocusing(id) === true;
        F.pause();
        const paused = !PomodoroApp.isRunning && F.isFocusing(id) === false;
        PomodoroApp.linkedTaskId = null; PomodoroApp.currentTask = ''; PomodoroApp.saveData();
        S.completeTask(id);
        const done = S.getTask(id).resolved === true;
        ScheduleApp.deleteTask(id);
        const pass = exposed && created && running && stopped && linked && paused && done;
        return { pass, detail: JSON.stringify({ exposed, created, running, stopped, linked, paused, done }) };
      });
    }
  },
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
        const expected = ['agent','actions','goals','calendar','email','fyi','notes','journal','prompts','bookmarks','news','library','reader','wellness','portfolio','browse','pomodoro','settings','aiactivity','help','about'];
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
    name: 'Portfolio loads from its package: six views, Money tile, widget, resolver domains',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const manifest = (BundledApps._loaded || []).find(m => m.id === 'portfolio');
        const views = ['portfolio','portfolio-ticker','portfolio-property','portfolio-liability','portfolio-transaction','portfolio-snapshots']
          .every(id => !!document.querySelector(`#app-views > #${id}-view.view`));
        const tile = document.querySelector('#app-registry .dash-apps-section .dash-app-tile[data-app="portfolio"]');
        const inGroup = !!tile && tile.closest('.dash-apps-group')?.querySelector('.dash-apps-group-label')?.textContent.trim() === 'Money';
        const launcher = GlobalSearch.launcherApps().some(a => a.id === 'portfolio' && a.title === 'Portfolio');
        const label = Breadcrumb.appLabels.portfolio === 'Portfolio';
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
    id: 'pkg-portfolio-tools-policy-and-vocabulary',
    name: 'Portfolio tools carry their policy; the domain predicate knows the user\'s account names',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const names = ['list_portfolio','get_ticker_detail','refresh_portfolio_prices','get_strategy','check_strategy','start_strategy_interview','save_strategy','delete_strategy','assign_strategy','get_holdings_news','add_transaction','update_cash'];
        const tools = names.every(n => typeof AgentTools.handlers[n] === 'function' && AgentTools._toolGroups[n] === 'portfolio' && AgentTools._dynamicTools[n]?.source === 'portfolio');
        const ask = ['add_transaction','update_cash','delete_strategy'].every(n => PermissionManager.resolve(n, {}).decision === 'ask')
          && PermissionManager.resolve('save_strategy', {}).decision === 'allow';
        const untrusted = ['add_transaction','update_cash'].every(n => AgentService.UNTRUSTED_BLOCKED_TOOLS.has(n)) && !AgentService.UNTRUSTED_BLOCKED_TOOLS.has('list_portfolio');
        const readOnly = ['refresh_portfolio_prices','check_strategy','start_strategy_interview'].every(n => AgentService._isReadOnlyTool(n)) && !AgentService._isReadOnlyTool('save_strategy');
        const privacy = ['list_portfolio','get_ticker_detail','get_strategy','check_strategy'].every(n => CloudPrivacy.TOOL_CLASS[n] === 'portfolio');
        const describe = /Record a buy/.test(AgentUI._describeToolAction('add_transaction', { type: 'buy', quantity: 3, ticker: 'AAPL', accountName: 'IRA' }))
          && /Deposit/.test(AgentUI._describeToolAction('update_cash', { operation: 'deposit', amount: 50, accountName: 'IRA' }));
        // Vocabulary: market nouns AND the user's own account name (a predicate, not a regex).
        const r = await AgentTools.handlers.add_transaction({ accountName: 'Zebra Brokerage', type: 'holding', ticker: 'ZZZT', quantity: 1, pricePerShare: 1 });
        const vocab = AgentTools._domainsForMessage('how are my stocks doing').has('portfolio')
          && AgentTools._domainsForMessage('what is in zebra brokerage').has('portfolio')
          && !AgentTools._domainsForMessage('rename my note').has('portfolio');
        // The task planner consults the same matcher (no second regex to drift).
        const implied = TaskService._impliedGroups('review my holdings this week').includes('portfolio')
          && TaskService._impliedGroups('what did zebra brokerage do').includes('portfolio');
        const search = !!GlobalSearch._sources.portfolio && GlobalSearch.data('zebra').some(h => h.app === 'portfolio' && h.meta?.kind === 'account');
        // clean up the account + transaction
        const pf = StorageManager.get('portfolio') || {};
        const acct = (pf.accounts || []).find(a => a.name === 'Zebra Brokerage');
        if (acct) {
          pf.accounts = pf.accounts.filter(a => a.id !== acct.id);
          pf.transactions = (pf.transactions || []).filter(t => t.accountId !== acct.id);
          pf.tombstones = Object.assign({}, pf.tombstones, { [acct.id]: new Date().toISOString(), [r.transaction.id]: new Date().toISOString() });
          StorageManager.set('portfolio', pf);
        }
        const pass = tools && ask && untrusted && readOnly && privacy && describe && vocab && implied && search;
        return { pass, detail: JSON.stringify({ tools, ask, untrusted, readOnly, privacy, describe, vocab, implied, search }) };
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
        const decisions = ['task','goal','note','routine','strategy','account'].every(t => decisionTypes.includes(t)) && !decisionTypes.includes('ticker');
        const words = RecordMention.TYPE_WORDS;
        const mention = words.strategies === 'Strategy' && words.account === 'Account'
          && words.goal === 'Project' && words.project === 'Project';
        const label = AgentUI._recordTypeLabel('portfolio:strategy:x') === 'Strategy'
          && AgentUI._recordTypeLabel('portfolio:ticker:AAPL') === 'Ticker'
          && AgentUI._recordTypeLabel('schedule:1') === 'Task'
          && AgentUI._recordTypeLabel('portfolio:overview') === 'Record';
        const keys = RecordTypes.recordKey('account', 'a1') === 'portfolio:account:a1'
          && DecisionStore.fromRecordKey('portfolio:strategy:s1') === 'strategy:s1'
          && DecisionStore.fromRecordKey('portfolio:ticker:AAPL') === null
          && DecisionStore.fromRecordKey('goals:g1') === 'goal:g1';
        const en = AgentTools.definitions.find(d => d.function.name === 'save_decision').function.parameters.properties.type.enum;
        const enumOk = ['strategy','account','task'].every(t => en.includes(t)) && !en.includes('ticker');
        // resolveKey through the registry: a strategy by name.
        const saved = PortfolioStrategy.save({ name: 'Pkg Test Plan', objective: 'test' });
        const r = DecisionStore.resolveKey('strategy', { name: 'Pkg Test Plan' });
        const resolves = r.key === `strategy:${saved.id}` && r.recordTitle === 'Pkg Test Plan';
        const bad = !!DecisionStore.resolveKey('ticker', { id: 'AAPL' }).error && !!DecisionStore.resolveKey('task', {}).error;
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
    name: 'A package registers its starter routine (+ retirements) and quick-start pill',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const mr = StarterPrompts.ITEMS.find(it => it.id === 'starter-market-review');
        const starter = !!mr && mr.marketTime === '16:30' && mr.config.interval === 'weekdays';
        const retired = ['starter-portfolio-premarket','starter-portfolio-midday','starter-portfolio-close'].every(id => StarterPrompts.RETIRED.some(r => r.id === id));
        const seeded = (StorageManager.get('starter-prompts')?.ids || []).includes('starter-market-review')
          || NotePrompts._readNotes().some(n => n.id === 'starter-market-review');
        const pill = AgentUI.GENERAL_SUGGESTIONS.some(s => s.text === 'How is my portfolio doing?');
        const noDup = AgentUI.registerSuggestion({ text: 'How is my portfolio doing?' }) === true
          && AgentUI.GENERAL_SUGGESTIONS.filter(s => s.text === 'How is my portfolio doing?').length === 1;
        const pass = starter && retired && seeded && pill && noDup;
        return { pass, detail: JSON.stringify({ starter, retired, seeded, pill, noDup }) };
      });
    }
  },
  {
    id: 'pkg-bundled-bookmarks-subapp-and-browse-api',
    name: 'Bookmarks loads from its package; Browse and the shell act only through its seams',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const manifest = (BundledApps._loaded || []).find(m => m.id === 'bookmarks');
        const views = ['bookmarks','bookmark-viewer','bookmark-editor'].every(id => !!document.querySelector(`#app-views > #${id}-view.view`));
        const tile = document.querySelector('#app-registry .dash-apps-section .dash-app-tile[data-app="bookmarks"]');
        const subapp = !!tile && tile.dataset.subappOf === 'browse' && !GlobalSearch.launcherApps().some(a => a.id === 'bookmarks');
        const label = Breadcrumb.appLabels.bookmarks === 'Bookmarks';
        const tool = typeof AgentTools.handlers.create_bookmark === 'function' && AgentTools._toolGroups.create_bookmark === 'bookmarks'
          && AgentTools._domainsForMessage('bookmark this').has('bookmarks') && TaskService._impliedGroups('save this link for me').includes('bookmarks');
        const r = await AgentTools.handlers.create_bookmark({ url: 'https://example.test/pkg', title: 'Pkg Test Link' });
        const chip = AgentUI._openableFromResult('create_bookmark', r);
        const openable = !!chip && chip.label === 'Open bookmark';
        const pill = WriteLedger.RECORD_TOOLS.create_bookmark?.[0] === 'bookmarks' && AgentTools._recordLabels.bookmarks === 'Bookmark';
        const link = RecordLinks.TYPES.bookmark?.exists(r.bookmark.id) === true && /\bbookmark\b/.test(RecordLinks.promptTypes());
        const typed = AgentUI._recordTypeLabel('bookmarks:' + r.bookmark.id) === 'Bookmark' && !DecisionStore.TYPES.includes('bookmark');
        const search = GlobalSearch.data('pkg test link').some(h => h.app === 'bookmarks' && h.id === r.bookmark.id) && GlobalSearch.appLabel('bookmarks') === 'Bookmark';
        const links = LinkManager.linkableApps().includes('bookmarks') && LinkPicker.appLabelsPlural.bookmarks === 'Bookmarks'
          && LinkManager.getItemMeta('bookmarks', r.bookmark.id)?.url === 'https://example.test/pkg'
          && typeof LinkManager._apps.bookmarks.createNew === 'function';
        const api = Anjadhe.use('bookmarks');
        const browse = !!api && api.has('https://example.test/pkg') && api.removeByUrl('https://example.test/pkg') === 1 && !api.has('https://example.test/pkg')
          && !/StorageManager\.get\('bookmarks'\)/.test(String(BrowseApp._loadBookmarks) + String(BrowseApp._toggleBookmark));
        const pass = !!manifest && views && subapp && label && tool && openable && pill && link && typed && search && links && browse;
        return { pass, detail: JSON.stringify({ manifest: !!manifest, views, subapp, label, tool, openable, pill, link, typed, search, links, browse }) };
      });
    }
  },
  {
    id: 'pkg-bundled-news-webrun-and-schedule-api',
    name: 'News loads from its package: get_news rides routine web runs, tasks go through the schedule API',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const manifest = (BundledApps._loaded || []).find(m => m.id === 'news');
        const view = !!document.querySelector('#app-views > #news-view.view');
        const tile = document.querySelector('#app-registry .dash-apps-section .dash-app-tile[data-app="news"]');
        const launcher = !!tile && tile.closest('.dash-apps-group')?.querySelector('.dash-apps-group-label')?.textContent.trim() === 'Stay on top'
          && GlobalSearch.launcherApps().some(a => a.id === 'news');
        const tool = typeof AgentTools.handlers.get_news === 'function' && AgentTools._toolGroups.get_news === 'news'
          && AgentTools._webRunTools.has('get_news') && AgentService._isReadOnlyTool('get_news')
          && AgentTools._domainsForMessage('any headlines today?').has('news') && TaskService._impliedGroups('summarize the news').includes('news');
        const starter = StarterPrompts.ITEMS.some(it => it.id === 'starter-news-digest' && it.config.web === true);
        const pill = AgentUI.GENERAL_SUGGESTIONS.some(s => s.text === 'Catch me up on the news');
        const api = Anjadhe.use('news');
        const exposed = !!api && ['settings','openReader','headlines'].every(k => typeof api[k] === 'function') && Array.isArray(api.settings().interests);
        const noReach = !/NewsApp\./.test(String(PortfolioNews._bind)) && !/StorageManager\.set\('schedule'/.test(String(NewsApp._addEvent));
        // The schedule API grew provenance fields + allTasks for the dedup.
        const S = Anjadhe.use('schedule');
        const id = S.createTask({ title: 'Pkg news event', startTime: '10:30', scheduledDate: '2030-01-02', source: 'news', sourceNewsUrl: 'https://example.test/n' });
        const t = S.allTasks().find(x => x.id === id);
        const fields = !!t && t.startTime === '10:30' && t.scheduledDate === '2030-01-02' && t.source === 'news' && t.sourceNewsUrl === 'https://example.test/n';
        ScheduleApp.deleteTask(id);
        const pass = !!manifest && view && launcher && tool && starter && pill && exposed && noReach && fields;
        return { pass, detail: JSON.stringify({ manifest: !!manifest, view, launcher, tool, starter, pill, exposed, noReach, fields }) };
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
