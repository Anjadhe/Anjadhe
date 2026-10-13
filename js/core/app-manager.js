/**
 * App Manager
 * Handles app registration, routing, and lifecycle
 */

const Breadcrumb = {
    /**
     * App display labels
     */
    appLabels: {
        actions: 'Tasks',
        goals: 'Projects', fyi: 'Insights', schedule: 'Tasks', notes: 'Text Documents',
        calendar: 'Calendar',
        // Bundled packages add their own (BundledApps: manifest `name` /
        // `extraApps[].name` — reader/library come from js/apps/reader/).
        settings: 'Settings', agent: 'Assistant', conversations: 'Conversations', updates: 'Updates'
    },

    /**
     * Render breadcrumbs into a container element
     * @param {string} containerId - DOM element ID
     * @param {Array} crumbs - Array of {label, action} where action is a function or null (current)
     */
    render(containerId, crumbs) {
        const el = document.getElementById(containerId);
        if (!el) return;

        let html = '';
        crumbs.forEach((crumb, i) => {
            if (i > 0) html += '<span class="breadcrumb-separator">&#8250;</span>';
            // A crumb renders as a link whenever it has an action, even if
            // it's the last one — useful for detail views where the page
            // itself is implicitly "current" and the last named crumb (e.g.
            // "Email") should still link back to its list.
            if (crumb.action) {
                html += `<span class="breadcrumb-link" data-crumb-index="${i}">${AppManager.escapeHtml(crumb.label)}</span>`;
            } else {
                html += `<span class="breadcrumb-current">${AppManager.escapeHtml(crumb.label)}</span>`;
            }
        });

        el.innerHTML = html;

        el.querySelectorAll('.breadcrumb-link').forEach(link => {
            link.addEventListener('click', () => {
                const idx = parseInt(link.dataset.crumbIndex);
                const crumb = crumbs[idx];
                if (crumb && crumb.action) crumb.action();
            });
        });
    }
};

const AppManager = {
    currentApp: null,
    apps: {},
    // Titlebar Back button history: app names (or 'home'), most recent last.
    // In-memory on purpose — history is a within-session notion. _navBack is
    // true only while goBack() is retracing, so the step isn't re-recorded.
    _navStack: [],
    _navBack: false,
    // Set for the duration of ONE openApp, by openAppFromLauncher. A jump is
    // not a push: see that method for why.
    _navJump: false,
    isLocked: false,
    activityTimer: null,
    activityCheckInterval: null,
    lastActivityTime: Date.now(),
    authAvailable: false,
    authEnabled: false,
    autoLockTimeout: 5,

    // The per-app "Locked apps" gate was retired 2026-10-07 (see the App
    // Lock note below); the field stays false for the guards that read it.
    sensitiveUnlocked: false,

    /**
     * Initialize the app manager
     */
    async init() {
        // Check for first-run setup
        if (window.electronStore.isFirstRun()) {
            this.showSetup();
            return;
        }

        // Hide any UI marked with data-feature="<key>" when its flag is off.
        // Must run before routing so gated apps aren't reachable via hash.
        if (typeof FEATURES !== 'undefined') {
            FEATURES.applyToDocument();

        }

        // Bundled app packages (js/apps/bundled.json — docs/PLATFORM.md "App
        // packages"): styles, view, registry tile and scripts come from the
        // package folder, before applyHiddenApps reads the registry tiles.
        if (typeof BundledApps !== 'undefined') {
            try {
                await BundledApps.load();
            } catch (e) {
                console.error('Bundled app loading failed:', e);
            }
        }

        this.setupTheme();
        this.setupNavigation();
        // Repaint every "AI Assistant" surface with the user-chosen name
        // (setup's last step / Settings › AI Assistant), if one is set —
        // and, when there isn't one and it was never waved away, mount the
        // quiet "give it a name" nudge on Home + the assistant view.
        if (typeof AssistantIdentity !== 'undefined') {
            AssistantIdentity.applyToDom();
            AssistantIdentity.mountNudges();
        }
        this.setupMenuActions();
        // ⌘K. Binds one document-level listener; the overlay mounts lazily
        // on first open (docs/POSITIONING.md — this is what lets the app
        // list leave the nav).
        if (typeof CommandPalette !== 'undefined') CommandPalette.init();
        // Titlebar app switcher beside the wordmark — the popover mounts
        // lazily on first open, same as ⌘K.
        // The global left rail. After bundled packages load, so every
        // app is in the registry before the first paint; applyHiddenApps
        // and handleRoute below re-render and mark the active row.
        if (typeof SimpleExperience !== 'undefined') SimpleExperience.init();
        // Auto-saving editors flush when the window hides or unloads
        // (navigation inside the app flushes in _notifyAppHidden).
        if (typeof SaveStatus !== 'undefined') SaveStatus.init();
        this.setupRouting();
        this.setupSyncIndicator();

        if (typeof MemoryManager !== 'undefined') MemoryManager.init();

        // Focus areas → goal group labels (2026-07-31): stamp `group` on
        // goals that predate the field, then purge the retired focus links.
        // One-shot, idempotent — steady-state startups write nothing.
        // MUST run before cleanupStaleLinks: getItemMeta no longer resolves
        // 'focus', so the cleanup would otherwise drop the very links the
        // migration derives the groups from.
        GoalsApp.migrateFromFocus();
        // Clean up stale cross-app links on startup
        LinkManager.cleanupStaleLinks();
        // Decisions whose host record is gone (deleted goal, removed
        // account). Grace-windowed and existence-tri-stated inside — see
        // DecisionStore.pruneOrphans.
        try { if (typeof DecisionStore !== 'undefined') DecisionStore.pruneOrphans(); } catch (e) { console.warn('[decisions] orphan prune failed:', e); }
        try { if (typeof UpdateStore !== 'undefined') UpdateStore.pruneOrphans(); } catch (e) { console.warn('[updates] orphan prune failed:', e); }
        // A local model picked on the setup page starts downloading once
        // the app is up (consume-once; see resumeSetupDownload).
        setTimeout(() => { try { this.resumeSetupDownload(); } catch (e) { console.warn('[setup] resume download failed:', e); } }, 2000);

        // Routing first: the hash names the page; with none, home (Threads).
        this.handleRoute();
        this.applyHiddenApps();

        // Start schedule notifications (runs globally, not just when schedule app is open)
        this.setupScheduleNotifications();

        // No routine is seeded on install (2026-10-05, by request): a routine
        // exists only because the person made it or approved it.

        // The routine trigger engine — scheduler, queue, per-routine state
        // (docs/ROUTINE_TRIGGERS.md R5). Started HERE, before any UI, because
        // that is defect D5: a trigger's liveness must never depend on a view
        // being visited. It also starts the mail sync when an armed routine
        // carries an email trigger, which used to be the Home widget's job.
        // A routine is a Standing conversation (2026-10-07, NotePrompts): the
        // list has to be loaded before the engine reads it.
        if (typeof AgentService !== 'undefined' && AgentService.loadConversations) AgentService.loadConversations();
        if (typeof RoutineEngine !== 'undefined') RoutineEngine.init();
        if (typeof BackgroundRuntime !== 'undefined') BackgroundRuntime.init();
        // Every job runs on the workroom engine (TeamJobs, docs/COWORK_AGENT.md).
        if (typeof TeamJobs !== 'undefined') TeamJobs.init();

        // The feed surface itself (rendering, run execution). No-ops with no
        // routines or no local model.
        if (typeof PromptFeed !== 'undefined') PromptFeed.init();

        // Pick the email-insight backlog back up, whatever view this session
        // opened on. It is persisted work (a Re-analyze run is hundreds of
        // model calls), and BackgroundWork lets a Cmd+R through without asking
        // precisely because it resumes — but resuming used to depend on
        // landing in Email or on Home. Deferred past first paint: the drain
        // itself is paced, and a session with nothing queued pays one kv read.
        if (typeof EmailApp !== 'undefined') {
            setTimeout(() => { EmailApp.resumeAnalysisBacklog(); }, 3000);
        }

        // iCloud Reminders → Tasks import (per-Mac opt-in; no-op when off).
        // Started here, not from a view — an import's liveness must not
        // depend on Settings or Schedule being visited (the D5 rule).
        if (typeof AppleImport !== 'undefined') AppleImport.init();
        if (typeof AppleNotesSource !== 'undefined') AppleNotesSource.init();
        // Google Calendar's poll and focus refresh: same rule (2026-10-05).
        // They used to start only when the Calendar page was opened.
        try { if (typeof CalendarApp !== 'undefined') CalendarApp.startBackground(); } catch (e) { console.warn('[calendar] background sync not started:', e?.message); }
        // Texts as an insight source (per-Mac opt-in; no-op when off). Same
        // rule: registered with the email engine and polling from here, so
        // a conversation is read whether or not Email AI is ever opened.
        if (typeof IMessageSource !== 'undefined') IMessageSource.init();
        // A test instance's simulated mail and texts (no-op on a real install).
        if (typeof SimSources !== 'undefined') SimSources.init();

        // The person's own tasks and calendar events as sources for their
        // folders (docs/MATTERS.md §15; flag `mattersources`, default off).
        if (typeof MatterSources !== 'undefined') MatterSources.init();

        // The assistant's own looks (docs/PROACTIVE.md): meeting prep, the
        // morning notice, follow-up drafts. Started here for the D5 reason.
        // nenva cloud and search usage: an hourly look that says so once at
        // 80% and once when the month's allowance is used (docs/BILLING.md).
        if (typeof PlanUsage !== 'undefined') PlanUsage.init();
        if (typeof Proactive !== 'undefined' && typeof FEATURES !== 'undefined'
            && FEATURES.isEnabled('proactive')) {
            Proactive.init();
            if (typeof Trips !== 'undefined') Trips.init();
            if (typeof Rhythm !== 'undefined') Rhythm.init();
            // Commitments (docs/COMMITMENTS.md), behind its flag: migrates once.
            if (typeof Commitments !== 'undefined') Commitments.init();
            // Senders (docs/SENDERS.md M1): places matters and commitments in the
            // long-lived things they belong to; the first sweep groups what exists.
            if (typeof Senders !== 'undefined') Senders.init();
            if (typeof CommitmentKinds !== 'undefined') CommitmentKinds.init();
            // Each sender's own look, at its own pace (docs/SENDERS.md M6).
            if (typeof SenderLook !== 'undefined') SenderLook.init();
            if (typeof CommitmentsPage !== 'undefined') CommitmentsPage.mount();
            if (typeof WorkPlans !== 'undefined') WorkPlans.init();
        }

        // Tasks the person taught by showing them (docs/TEACH.md): each one
        // is a playbook the Browser agent reads, so they load before any job.
        if (typeof TaughtTasks !== 'undefined') { try { TaughtTasks.init(); } catch (e) { console.warn('[taught-tasks] init failed:', e?.message); } }

        // Notes + Journal as Markdown files in ~/nenva/ — projection out,
        // outside edits in. Same rule: started here, never from a view.
        if (typeof ContentFiles !== 'undefined') ContentFiles.init();
        // Telegram remote channel — answers messages main's bridge forwards.
        // Same rule again: a remote question must be answered whether or not
        // any particular view was ever opened.
        if (typeof TelegramChannel !== 'undefined') TelegramChannel.init();
        // Notification funnel — caches whether Telegram forwarding is live
        // so the reminder scan below runs even without macOS permission.
        if (typeof Notify !== 'undefined') Notify.init();
        // What reaches the phone unprompted (Now's new cards, timed
        // commitments, approvals): js/core/phone-reach.js.
        if (typeof PhoneReach !== 'undefined') PhoneReach.init();
        // phone<->Mac channel (see js/agent/mobile-channel.js).


        // Setup authentication
        await this.setupAuth();

        // Opt-in usage analytics: if the user has enabled it, schedule a
        // delayed upload of any pending events. Throttled to once per hour.
        if (typeof AnalyticsManager !== 'undefined') {
            AnalyticsManager.noteLaunch();
            // One id for this Mac (see AnalyticsManager.adoptSharedId). Before
            // the upload, so events go under the id every other surface shows.
            AnalyticsManager.adoptSharedId().finally(() => {
                AnalyticsManager.scheduleStartupUpload();
            });
            if (AnalyticsManager.shouldNudgeOptIn()) {
                // Delay the ask so it doesn't land on top of any first-paint
                // work or a route-restored view the user is already reading.
                // Note this runs on every RENDERER init (Cmd+R, a flag flip,
                // a second window, the reload that ends setup) — noteLaunch
                // counts days, not inits, so a fresh install is not asked
                // minutes in. See AnalyticsManager.NUDGE_AFTER_DAYS_USED.
                setTimeout(() => this._showAnalyticsOptInNudge(), 12000);
            }
        }

        // The free-license claim door (js/core/license-claim.js): reads
        // status from main, materialises the checklist step, and schedules
        // the one-time nudge for installs that dismissed the checklist. It
        // checks the analytics nudge above so the two never share a launch.
        if (typeof LicenseClaim !== 'undefined') {
            LicenseClaim.init().catch(() => {});
        }

        // Resolve the local-model context window from the user's
        // setting (or auto-derive from RAM) up-front so prewarm and the
        // first sendMessage agree on num_ctx — otherwise the engine loads
        // a second runner copy and we pay ~3-4s + ~5GB extra weight.
        if (typeof AgentService !== 'undefined' && typeof AgentService.initNumCtx === 'function') {
            AgentService.initNumCtx().catch(() => { /* falls back to default */ });
        }

        // Pre-warm the local model into resident memory so the user's first
        // message doesn't pay the cold-load cost. Deferred past first paint
        // and non-blocking — remote-only users and missing-engine setups no-op.
        if (typeof AgentService !== 'undefined' && typeof AgentService.prewarm === 'function') {
            setTimeout(() => { AgentService.prewarm(); }, 2500);
        }

        // While llama.cpp network sharing is on, other Macs rely on this
        // machine's llama-server staying up — the watchdog re-loads the model
        // if it ever goes away mid-session (crash, eviction). No-op otherwise.
        if (typeof AgentService !== 'undefined' && typeof AgentService.startShareWatchdog === 'function') {
            AgentService.startShareWatchdog();
        }

        // Guard against losing in-flight model work to a window close, Cmd+Q
        // or a Force Reload. Setting returnValue cancels the unload; the main
        // process (will-prevent-unload) then shows a native "Leave anyway?"
        // confirm worded from what we send it here. Cmd+R goes through
        // requestReload, which shows its own richer dialog first and sets
        // _unloadConfirmed so the user is not asked twice. Resumable
        // background work (ambient email analysis) never prompts — same rule
        // as the reload dialog, for the same reason: a dialog that fires for
        // work nothing is lost on trains the reflex click.
        window.addEventListener('beforeunload', (e) => {
            if (this._unloadConfirmed) return;
            // The eval harness (tests/agent-evals) closes the app with fixture
            // work still registered; a native Stay/Leave dialog there hangs the
            // run. Same exemption _confirmWrite makes for the consent dialog.
            if (window.__eval) return;
            // Editors write synchronously here; only what CANNOT be written
            // is left for the guard to name.
            if (typeof SaveStatus !== 'undefined') SaveStatus.flushAll();
            const guard = this._unloadGuard();
            if (!guard) return;
            try { window.electronMenu?.setUnloadGuard?.(guard); } catch { /* dialog falls back to generic copy */ }
            e.preventDefault();
            // Non-empty so Electron fires will-prevent-unload (where the
            // main process shows the actual confirm). The string itself is
            // not displayed.
            e.returnValue = 'work-in-progress';
        });
    },

    _showAnalyticsOptInNudge() {
        if (typeof AnalyticsManager === 'undefined' || typeof Modal === 'undefined') return;
        if (!AnalyticsManager.shouldNudgeOptIn()) return;
        // Record "we asked" up front and durably — so the nudge never
        // reappears even if the modal is dismissed without a button
        // (overlay click, Escape) or a later state write races it.
        AnalyticsManager.markNudged();

        const esc = (t) => (typeof UIUtils !== 'undefined' && UIUtils.escapeHtml)
            ? UIUtils.escapeHtml(String(t)) : String(t);

        // The disclosure IS the payload (the Send Feedback card's rule):
        // the list below is built from AnalyticsManager's own VOCABULARY and
        // the real install id, so what this card shows cannot drift from what
        // a send would carry. An event name off that list is rejected before
        // it is ever recorded.
        const vocab = AnalyticsManager.VOCABULARY || {};
        const rows = Object.keys(vocab).map((name) => {
            const props = Object.keys(vocab[name] || {});
            return `<li><code>${esc(name)}</code>${props.length
                ? `<span class="analytics-ask-props">${esc(props.join(', '))}</span>` : ''}</li>`;
        }).join('');

        const content = document.createElement('div');
        content.className = 'analytics-ask';
        content.innerHTML = `
            <p class="analytics-ask-lead">
                nenva has no accounts and no server watching you work. That is
                the whole point of it &mdash; and it also means I have no way of
                knowing whether anyone is actually using what I build. If you
                never use nenva Connect, this Mac has never said a word to me.
            </p>
            <p class="analytics-ask-body">
                Anonymous counts are the only way I learn which parts are worth
                building on and which ones to stop spending your time on. It is
                a small thing to give, and it genuinely decides what gets made
                next. Either answer is fine, and nothing in the app changes.
            </p>
            <div class="analytics-ask-promise">
                <strong>Never what you write.</strong> Not a line of your notes,
                journal, mail, documents, projects or chats. No names, no email
                addresses, no file names, no searches, no prompts and no replies.
                Nothing you typed goes with it.
            </div>
            <details class="analytics-ask-more">
                <summary>See exactly what would be sent</summary>
                <div class="analytics-ask-more-body">
                    <p>
                        Each event is a name off this fixed list, the time it
                        happened, and a random id for this Mac that is tied to
                        no account, email or license. That is the entire
                        payload.
                    </p>
                    <ul class="analytics-ask-vocab">${rows}</ul>
                    <p class="analytics-ask-fine">
                        The list is the whole vocabulary the app is capable of
                        recording; anything not on it is refused before it is
                        written down. Everything sits on this Mac until it is
                        sent, and you can read every recorded event, or turn
                        this off again, in Settings &rsaquo; Privacy.
                    </p>
                </div>
            </details>
            <p class="analytics-ask-foot">
                Would you rather just tell me how it is going?
                <button type="button" class="analytics-ask-link" data-ask-feedback>Send feedback instead</button>
            </p>
        `;

        let decided = false;
        const markDecided = () => {
            if (decided) return;
            decided = true;
            AnalyticsManager.markNudged();
        };

        const modal = Modal.create({
            title: 'A small ask',
            className: 'analytics-ask-modal',
            content,
            buttons: [
                {
                    text: 'No thanks',
                    className: 'secondary-btn',
                    onClick: () => {
                        markDecided();
                        modal.close();
                    },
                },
                {
                    text: 'Share anonymous usage',
                    className: 'primary-btn',
                    onClick: () => {
                        AnalyticsManager.setEnabled(true);
                        markDecided();
                        modal.close();
                        if (typeof UIUtils !== 'undefined' && UIUtils.showToast) {
                            UIUtils.showToast('Thank you — you can turn this off in Settings › Privacy', 'success');
                        }
                    },
                },
            ],
            onClose: () => markDecided(),
        });

        // The other door: saying it in words. Declining analytics and having
        // something to say are not the same answer, so this closes the card
        // without turning anything on.
        content.querySelector('[data-ask-feedback]')?.addEventListener('click', () => {
            markDecided();
            modal.close();
            SimpleSettings.open('feedback');
        });
    },

    showSetup() {
        this._clearInitialLoader();

        // The wizard owns the whole window — hide the global left nav
        // (finishSetup reloads, which clears this again).
        document.body.classList.add('in-setup');

        // Show setup view
        const setupView = document.getElementById('setup-view');
        setupView.style.display = 'flex';

        // ── One page, one default (2026-10-01) ───────────────────────────
        // The AI model, chosen for the user and changeable in place; Get
        // started applies it.
        //
        // The model default follows the Mac (Ram: "nenva cloud lite default
        // for mac less than 32gb ram"): under 32 GB it is nenva cloud lite;
        // at 32 GB or more it is nenva local, the catalog's recommended model
        // for this much memory (its largest `default: true` entry that fits).
        // A local model is gigabytes, so it downloads AFTER setup in the
        // background (resumeSetupDownload) with nenva cloud lite answering
        // until it is ready and becomes the default. The cloud catalog is
        // Connect's managed lineup; unreachable, it falls back to lite.
        const LOCAL_DEFAULT_MIN_GB = 32;
        const modelSel = document.getElementById('setup-model');
        const modelHint = document.getElementById('setup-model-hint');
        const cloudModelsPromise = (async () => {
            try { return await window.electronLLM?.anjadheModels?.(); } catch { return null; }
        })();
        const configPromise = (async () => {
            try { return await window.electronConfig?.get?.(); } catch { return null; }
        })();
        let localPick = null;
        const nameEl = document.getElementById('setup-model-name');
        const choices = document.getElementById('setup-model-choices');
        const changeBtn = document.getElementById('setup-model-change');
        const paintHint = () => {
            const v = modelSel.value || '';
            const opt = Array.from(modelSel.options).find(o => o.value === v);
            nameEl.textContent = opt ? opt.textContent : 'nenva cloud lite';
            modelHint.textContent = v.startsWith('local:')
                ? `Runs on this Mac. It downloads${localPick?.size ? ` (${localPick.size})` : ''} after you start; nenva cloud lite answers until then.`
                : 'Data on your Mac. AI on nenva cloud.';
            choices.innerHTML = Array.from(modelSel.options).map(o =>
                `<button type="button" role="radio" class="setup-one-choice" data-model="${UIUtils.escapeHtml(o.value)}" aria-checked="${o.value === v}">${UIUtils.escapeHtml(o.textContent)}</button>`).join('');
        };
        // Picking a model IS the answer: the pills close on the pick, and
        // "Change" only ever opens or closes them (no "Done" step).
        const showChoices = (open) => {
            choices.hidden = !open;
            changeBtn.setAttribute('aria-expanded', String(open));
        };
        changeBtn.addEventListener('click', () => showChoices(choices.hidden));
        choices.addEventListener('click', (e) => {
            const b = e.target.closest('[data-model]');
            if (!b) return;
            modelSel.value = b.dataset.model;
            paintHint();
            showChoices(false);
            changeBtn.focus();
        });
        (async () => {
            const [res, config] = await Promise.all([cloudModelsPromise, configPromise]);
            const cloud = (res && Array.isArray(res.models) && res.models.length)
                ? res.models : [{ id: ModelNames.DEFAULT_CLOUD_MODEL }];
            const ram = Number(config?.machine?.totalMemGB) || 0;
            const fits = (config?.models || []).filter(m => m.gguf && m.default && (m.minRam || 0) <= ram)
                .sort((x, y) => (y.minRam || 0) - (x.minRam || 0));
            const pick = fits[0] || null;
            localPick = pick ? { name: pick.name, size: typeof pick.size === 'string' ? pick.size : '' } : null;
            const esc = UIUtils.escapeHtml;
            const opts = cloud.map(m => `<option value="cloud:${esc(m.id)}">${esc(ModelNames.cloudLabel(m.id, m.label))}</option>`);
            if (localPick) opts.push(`<option value="local:${esc(localPick.name)}">nenva local</option>`);
            modelSel.innerHTML = opts.join('');
            const lite = cloud.find(m => m.id === ModelNames.DEFAULT_CLOUD_MODEL) || cloud[0];
            modelSel.value = (localPick && ram >= LOCAL_DEFAULT_MIN_GB) ? `local:${localPick.name}` : `cloud:${lite.id}`;
            paintHint();
        })();
        modelSel.addEventListener('change', paintHint);
        paintHint();

        const applyModel = async () => {
            if (typeof AgentService === 'undefined') return;
            if (AgentService.getModelList().length) return; // never replace a choice
            const value = modelSel.value || '';
            // A local model already on this Mac needs no stand-in: it is
            // the first entry, so it IS the default, and Home opens on it.
            // (Adding cloud lite first and switching after made the chat's
            // model chip show cloud for a moment, 2026-10-01.)
            if (value.startsWith('local:')) {
                const name = value.slice(6);
                let installed = false;
                try {
                    const r = await window.electronLlamaCpp?.listModels?.();
                    installed = ((r && r.models) || []).some(m => m.name === name);
                } catch { /* unknown: treat as not installed */ }
                if (installed) {
                    const local = AgentService.addEntry({ engine: 'llamacpp', model: name });
                    if (local) {
                        await AgentService._syncBrainToEntry(local);
                        AnalyticsManager?.record?.('model.added', { engine: 'llamacpp', source: 'setup' });
                        return;
                    }
                }
            }
            const res = await cloudModelsPromise;
            const cloud = (res && Array.isArray(res.models)) ? res.models : [];
            const cloudId = value.startsWith('cloud:') ? value.slice(6)
                : ((cloud.find(m => m.id === ModelNames.DEFAULT_CLOUD_MODEL) || cloud[0] || {}).id || ModelNames.DEFAULT_CLOUD_MODEL);
            const meta = cloud.find(m => m.id === cloudId);
            // The cloud entry is always added: it IS the brain for a cloud
            // pick, and the stand-in while a local pick downloads.
            const entry = AgentService.addEntry({ engine: 'anjadhe', model: cloudId, label: ModelNames.cloudLabel(cloudId, meta && meta.label) });
            // saveModelList's brain write-through is fire-and-forget, and
            // finishSetup reloads right after this — await it so
            // provider-routed work (email insights, routines) boots on the
            // brain rather than the 'local' default.
            if (entry) await AgentService._syncBrainToEntry(entry);
            if (typeof AnalyticsManager !== 'undefined') {
                AnalyticsManager.record('model.added', { engine: 'anjadhe', source: 'default' });
            }
            if (value.startsWith('local:')) {
                const local = AgentService.addEntry({ engine: 'llamacpp', model: value.slice(6) });
                if (local) {
                    try { localStorage.setItem('setup-local-download', local.id); } catch { /* best effort */ }
                    AnalyticsManager?.record?.('model.added', { engine: 'llamacpp', source: 'setup' });
                }
            }
        };

        // Web search and the assistant's name are NOT set here (2026-10-01,
        // Ram: "remove web search enablement, asssitant name. they can do
        // that later"). Web search stays unset, so the assistant's first
        // search asks in chat and that approval turns it on
        // (AgentService._webSearchUnset); the name nudge asks later.

        const startBtn = document.getElementById('setup-start-btn');
        const emailInput = document.getElementById('setup-email');
        const registrationStatus = document.getElementById('setup-registration-status');
        document.getElementById('setup-registration-copy').textContent = LicenseClaim.REGISTRATION_SHORT_COPY;
        let starting = false;
        let registered = false;
        const finishSetup = async () => {
            if (starting) return;
            if (!registered && !emailInput.checkValidity()) {
                registrationStatus.textContent = 'Enter a valid email address to continue.';
                emailInput.setAttribute('aria-invalid', 'true');
                emailInput.focus();
                return;
            }
            starting = true;
            startBtn.disabled = true;
            emailInput.disabled = true;
            emailInput.removeAttribute('aria-invalid');
            registrationStatus.textContent = '';
            try {
                if (!registered) {
                    startBtn.textContent = 'Getting your license…';
                    const result = await LicenseClaim.claim(emailInput.value);
                    if (result.error) {
                        registrationStatus.textContent = result.error;
                        return;
                    }
                    registered = true;
                    registrationStatus.textContent = LicenseClaim.doneLine(result);
                }
                startBtn.textContent = 'Starting…';
                await applyModel();
                // Web search stays unset until the assistant's first search asks
                // (see the note above); the cloud brain's Connect key must not
                // read as a choice.
                try { await window.electronSearch?.askFirst?.(); } catch { /* older main */ }
                // A new install is introduced to nenva gently for its first
                // week (SimpleExperience.gentle); this Mac starts now.
                try { localStorage.setItem(SimpleExperience.NEW_SINCE_KEY, String(Date.now())); } catch { /* per-Mac, a convenience */ }
                await window.electronStore.markSetupComplete();
                // Registration is complete; do not nudge again next launch.
                LicenseClaim.markNudged();
                // Land in the Assistant, not the 12-app grid (positioning:
                // never open with the suite). Read + cleared on next boot.
                // The simple home IS the assistant's composer, so setup lands
                // there (2026-10-01).
                window.location.reload();
            } catch {
                registrationStatus.textContent = registered
                    ? 'Your license is saved. Setup could not finish. Please try again.'
                    : 'Setup could not finish. Please try again.';
            } finally {
                starting = false;
                startBtn.disabled = false;
                emailInput.disabled = registered;
                startBtn.textContent = 'Get started';
            }
        };
        document.getElementById('setup-registration').addEventListener('submit', (e) => {
            e.preventDefault();
            finishSetup();
        });

        for (const id of ['setup-what-leaves-link', 'setup-pricing-link']) {
            document.getElementById(id)?.addEventListener('click', (e) => {
                e.preventDefault();
                // Details live on the website; keep setup in this window.
                window.electronAuth?.openExternal?.(e.currentTarget.href);
            });
        }
    },

    /**
     * A local model picked on the setup page downloads AFTER setup (the
     * page reloads on Get started, and a model is gigabytes). Consume-once:
     * Settings' own download path installs the engine if needed, pulls the
     * model and, as `_pendingDefaultId`, makes it the default when done.
     * Until then nenva cloud lite answers.
     */
    resumeSetupDownload() {
        let id = null;
        try { id = localStorage.getItem('setup-local-download'); localStorage.removeItem('setup-local-download'); } catch { return; }
        if (!id || typeof SettingsApp === 'undefined' || typeof AgentService === 'undefined') return;
        const entry = AgentService.getEntry?.(id);
        if (!entry) return;
        SettingsApp._pendingDefaultId = id;
        UIUtils.showToast('Downloading nenva local in the background. nenva cloud lite answers until it’s ready.', 'info');
        Promise.resolve(SettingsApp._startEntryDownload(id)).catch(e => console.warn('[setup] local model download failed:', e));
    },

    /**
     * Setup hash-based routing
     */
    setupRouting() {
        // Handle browser back/forward buttons. Hash assignments made by
        // openApp/showDashboard themselves are queued as echoes and skipped
        // here — without this, every navigation re-ran the target app's
        // init() a second time via its own hashchange (which, among other
        // things, clobbered consume-once deep-link flags like the email
        // app's _openToInsightDetail).
        window.addEventListener('hashchange', (e) => {
            const target = e.newURL ? (e.newURL.split('#')[1] || '') : window.location.hash.slice(1);
            const echoes = this._routeEchoes || [];
            const idx = echoes.indexOf(target);
            if (idx !== -1) {
                echoes.splice(idx, 1);
                return;
            }
            this.handleRoute();
        });
    },

    // Record that the next hashchange for `hash` is our own doing (an
    // openApp/showDashboard hash write), not a back/forward navigation.
    _queueRouteEcho(hash) {
        if (!this._routeEchoes) this._routeEchoes = [];
        this._routeEchoes.push(hash);
    },

    /**
     * Handle the current route based on URL hash
     * Supports: #app, #app/view/id, #app/edit/id
     */
    handleRoute() {
        const hash = window.location.hash.slice(1); // Remove the #

        if (hash === '' || hash === 'home') {
            this.showDashboard(false);
            this._clearInitialLoader();
            return;
        }

        const parts = hash.split('/');
        const appName = parts[0];
        const action = parts[1]; // 'view', 'edit', or undefined
        const id = parts.slice(2).join('/'); // ID (may contain /)

        if (appName === 'email' || appName === 'email-compose' || appName === 'email-priority') {
            this.showDashboard();
            if (appName === 'email' && action === 'view' && id && typeof EmailApp !== 'undefined') EmailApp.openMessageFrom(id);
            this._clearInitialLoader();
            return;
        }

        if (!this.apps[appName]) {
            this.showDashboard(false);
            this._clearInitialLoader();
            return;
        }

        this.openApp(appName, false);

        // Route to detail page if action + id present. Done synchronously so
        // the list view never paints before the detail view on refresh.
        if (action && id) {
            const app = this.apps[appName];
            if (action === 'edit' && app.openEditor) {
                app.openEditor(id);
            } else if (action === 'view' && app.openViewer) {
                app.openViewer(id);
            }
        }

        this._clearInitialLoader();
    },

    _clearInitialLoader() {
        document.body.classList.remove('app-loading');
    },

    /**
     * Update the URL hash for detail page routing (does not trigger hashchange navigation)
     */
    setDetailHash(appName, action, id) {
        const newHash = id ? `${appName}/${action}/${id}` : appName;
        if (window.location.hash.slice(1) !== newHash) {
            history.replaceState(null, '', '#' + newHash);
        }
    },

    /**
     * Register an app
     * @param {string} name - App name
     * @param {Object} app - App instance
     */
    register(name, app) {
        this.apps[name] = app;
    },

    /**
     * Tell the app we're navigating away from that it is no longer on
     * screen. Hiding a view only removes .active, which is display:none —
     * enough for ordinary DOM, but not for anything that keeps running
     * unseen — a timer, a poll, a media element that keeps playing.
     *
     * The counterpart is init()/render(), which already run on the way in.
     * Never let a misbehaving app block navigation.
     */
    _notifyAppHidden() {
        // Every open auto-saving editor writes NOW — a Back within the
        // debounce window must never leave the save to a timer against a
        // page that is no longer showing. What cannot be written (a new
        // task never Saved, a blank title) is announced with a way back.
        if (typeof SaveStatus !== 'undefined') SaveStatus.flushAll({ announce: true });
        const app = this.currentApp && this.apps[this.currentApp];
        if (app && typeof app.onHide === 'function') {
            try { app.onHide(); } catch (e) { console.warn('[nav] onHide failed', e); }
        }
    },

    /**
     * Navigate to an app
     * @param {string} appName - Name of app to open
     * @param {boolean} updateHash - Whether to update the URL hash (default: true)
     */
    // ── Opening a link ────────────────────────────────────────────────
    // nenva has no browser of its own (the Web Browser app was removed
    // 2026-09-20). A link followed from chat, a note, the journal, a feed
    // post or an app row opens in the Mac's DEFAULT browser, where the
    // user's sessions, extensions and password manager already are. Main
    // validates the scheme (http/https/mailto) before handing it to the OS.
    openExternal(url) {
        const s = String(url || '').trim();
        if (!s) return;
        window.electronAuth?.openExternal?.(s);
    },

    /**
     * Open an app from a LAUNCHER — the side nav, the titlebar switcher, ⌘K,
     * a dash tile — as opposed to following something.
     *
     * A back button is earned by a PUSH: you drilled into a record from chat,
     * took the Inbox → Task door, clicked a widget row, and what you were
     * reading is still worth returning to. Picking a different app off the
     * rail is a JUMP: you named the destination, nothing was left behind, and
     * "← Tasks" is then just history, pointing at a place you had already
     * finished with. It also made the button flicker in and out of the bar on
     * ordinary app switching.
     *
     * So launchers call this and the step is not recorded; everything else
     * keeps calling openApp and still gets its way back. That direction is
     * deliberate — a launcher door we forget to convert merely keeps today's
     * behaviour, whereas defaulting to "never push" would silently lose a
     * back button that was genuinely useful.
     *
     * The flag is consumed in a finally rather than read-and-cleared inside
     * openApp, because openApp re-enters itself for the app aliases
     * (schedule → actions) and the inner call must still see it.
     */
    openAppFromLauncher(appName, updateHash = true) {
        this._navJump = true;
        try { return this.openApp(appName, updateHash); }
        finally { this._navJump = false; }
    },

    openApp(appName, updateHash = true) {
        if (appName === 'schedule') return this.openApp('actions', updateHash);
        // The Calendar page left 2026-10-05 (today and the week are the top
        // of nenva's thread) and the Inbox 2026-10-07: both land on home.
        if (['calendar', 'email', 'email-compose', 'email-priority'].includes(appName)) { this.showDashboard(); return; }
        // Tasks and Projects are one surface now (docs/COMMITMENTS.md phase 5).
        if ((appName === 'actions' || appName === 'goals') && typeof CommitmentsPage !== 'undefined' && CommitmentsPage.takesOver()) {
            CommitmentsPage.open();
            return;
        }
        // Text Documents and the Documents library are one Documents (2026-10-07,
        // docs/SIMPLE_EXPERIENCE.md "One Documents"): a bare open of either old
        // view lands on the list; a document opens there through its doors.
        if ((appName === 'notes' || appName === 'reader') && typeof DocumentsPage !== 'undefined' && !this._intoOldDocView) {
            DocumentsPage.open();
            return;
        }

        const app = this.apps[appName];
        if (!app) {
            console.error(`App ${appName} not found`);
            return;
        }

        // The docked AI panel is anchored to the page it was opened over, so
        // dismiss it whenever the user navigates elsewhere. (Expand-to-full-view
        // already closes the panel itself before calling openApp('agent'), so
        // this is a no-op there.)
        if (typeof AgentUI !== 'undefined' && AgentUI.isOpen) AgentUI.close();

        // Refuse to open gated apps whose feature flag is off — stops a
        // stale URL hash from landing the user on a view that isn't ready to
        // ship.
        if (typeof FEATURES !== 'undefined' && FEATURES.isGated(appName) && !FEATURES.isEnabled(appName)) {
            this.showDashboard();
            return;
        }

        // Hide all views
        if (appName !== this.currentApp) this._notifyAppHidden();
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
        });
        // The first-run setup wizard reveals #setup-view with an inline
        // display style, which bypasses the .active class — the loop above
        // can't hide it. Clear it so it can't bleed through behind an app
        // the user navigated to before finishing setup.
        const setupView = document.getElementById('setup-view');
        if (setupView) setupView.style.display = 'none';

        // Show app view
        const appView = document.getElementById(`${appName}-view`);
        if (appView) {
            appView.classList.add('active');
            // Navigation history for the titlebar Back button. Push where we
            // came from ('home' when the dashboard was showing) unless this
            // navigation IS a back step (goBack sets _navBack so retracing
            // never re-records) or a same-app re-open (init/render refresh,
            // not a move). Going home clears the stack — home is the root.
            const from = this.currentApp || 'home';
            if (!this._navBack && !this._navJump && from !== appName) {
                this._navStack.push(from);
                if (this._navStack.length > 12) this._navStack.shift();
            }
            // Track where we came from. `null` means the dashboard (home),
            // which apps can use to decide entry behavior (e.g. the AI
            // Assistant starts a fresh chat when opened from home).
            this.previousApp = this.currentApp;
            this.currentApp = appName;
            this.updateAppPicker(appName);
            this.updateSidebarActive(appName);
            // "We're in a sub-app" CSS hook.
            document.body.classList.add('in-sub-app');

            // Opening the assistant full view? Re-warm the local model now so
            // it's resident by the time the user types — startup prewarm may
            // have expired during a long session. No-ops when already loaded.
            if (appName === 'agent' && typeof AgentService !== 'undefined'
                && typeof AgentService.warmOnIntent === 'function') {
                AgentService.warmOnIntent();
                if (typeof AgentUI !== 'undefined' && AgentUI.startReadinessWatch) {
                    AgentUI.startReadinessWatch();
                }
            }

            // Scroll to top when opening an app
            window.scrollTo(0, 0);

            // Update URL hash. The assignment fires a hashchange only when
            // the value actually changes — queue the echo exactly then.
            if (updateHash) {
                if (window.location.hash.slice(1) !== appName) this._queueRouteEcho(appName);
                window.location.hash = appName;
            }

            // Initialize app if it has an init method
            if (app.init && typeof app.init === 'function') {
                app.init();
            }

            // Render app
            if (app.render && typeof app.render === 'function') {
                app.render();
            }

            this.recordAppUse(appName);

            if (typeof AnalyticsManager !== 'undefined') {
                AnalyticsManager.record('app.opened', { app: appName });
            }
        }
    },

    /* ----------------------------------------------------------------
     * App usage — what ⌘K offers first (js/components/command-palette.js).
     *
     * FREQUENCY, not recency, since 2026-07-30. Recency answers "where was
     * I?", which you already know; frequency answers "where do I go?",
     * which is what a launcher is for. Recency also churned — one detour
     * into Settings pushed a daily app off the list — so the first row
     * under ⌘K kept moving, and a list that moves cannot be used by muscle
     * memory. Last-opened survives as the tiebreaker between apps you use
     * equally often.
     *
     * localStorage, not StorageManager, and deliberately so: this is
     * usage-pattern data that belongs to one Mac, and StorageManager syncs
     * everything not explicitly listed in main.js SYNC_EXCLUDE_KEYS. A key
     * that must never sync is safer somewhere that *cannot* sync than
     * somewhere that requires remembering to exclude it. (Same reasoning as
     * the theme.) Favourites are the opposite — a deliberate curation, so
     * those do sync.
     * ---------------------------------------------------------------- */
    _APP_USAGE_KEY: 'app-usage',
    _FREQUENT_APPS_MAX: 6,

    /** `{ [app]: { count, last } }` — raw, unsorted, never null. */
    getAppUsage() {
        try {
            const raw = JSON.parse(localStorage.getItem(this._APP_USAGE_KEY) || 'null');
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
        } catch { /* corrupt or absent */ }
        return {};
    },

    /**
     * Most-used first, last-opened breaking ties. Ids only — callers that
     * need labels and icons resolve them against the app registry.
     */
    getFrequentApps(limit = this._FREQUENT_APPS_MAX) {
        const usage = this.getAppUsage();
        return Object.keys(usage)
            .sort((a, b) =>
                (usage[b]?.count || 0) - (usage[a]?.count || 0)
                || (usage[b]?.last || 0) - (usage[a]?.last || 0)
                || a.localeCompare(b))
            .slice(0, limit);
    },

    recordAppUse(appName) {
        if (!appName) return;
        // Nothing is excluded. Home is not an app and never reaches this.
        const usage = this.getAppUsage();
        const prev = usage[appName] || { count: 0, last: 0 };
        usage[appName] = { count: (prev.count || 0) + 1, last: Date.now() };
        try {
            localStorage.setItem(this._APP_USAGE_KEY, JSON.stringify(usage));
        } catch { /* quota or private mode — the ordering is a nicety */ }
    },

    /* ----------------------------------------------------------------
     * Favourite apps. User-curated shortcuts pinned to the top of the
     * home page. Stored via StorageManager (so the picks follow the
     * user across Macs — this is a deliberate choice, unlike old
     * usage-derived "recents"). Order is the order they were added.
     * ---------------------------------------------------------------- */
    _FAVORITES_KEY: 'favorite-apps',

    getFavoriteApps() {
        const d = StorageManager.get(this._FAVORITES_KEY);
        return Array.isArray(d?.apps) ? d.apps.slice() : [];
    },

    setFavoriteApps(arr) {
        StorageManager.set(this._FAVORITES_KEY, { apps: Array.from(arr) });
    },

    isFavoriteApp(app) {
        return this.getFavoriteApps().includes(app);
    },

    toggleFavoriteApp(app) {
        const list = this.getFavoriteApps();
        const i = list.indexOf(app);
        if (i === -1) list.push(app);
        else list.splice(i, 1);
        this.setFavoriteApps(list);
    },

    /* ----------------------------------------------------------------
     * Customize home apps. We ship many apps; this lets a user hide the
     * ones they don't use. Stored via StorageManager (so the curated set
     * follows them across Macs — unlike usage counts, which are a
     * usage pattern and stay machine-local). Hiding an app keeps it out of
     * ⌘K's empty-query list; it stays findable by name (GlobalSearch.apps).
     * ---------------------------------------------------------------- */
    _HIDDEN_APPS_KEY: 'hidden-apps',

    /** The hidden set the person chose, else the default one (an install that never chose). */
    getHiddenApps() {
        const d = StorageManager.get(this._HIDDEN_APPS_KEY);
        return new Set(Array.isArray(d?.apps) ? d.apps : [...this.DEFAULT_HIDDEN_APPS, ...this.LAUNCHER_HIDDEN]);
    },

    setHiddenApps(set) {
        StorageManager.set(this._HIDDEN_APPS_KEY, { apps: Array.from(set) });
    },

    // Bundled packages append themselves via manifest `hiddenByDefault`.
    DEFAULT_HIDDEN_APPS: [],
    // ONE small launcher (2026-10-01, by request: testers said the app
    // "looks like an OS"): everything but the assistant, Insights and
    // Settings starts hidden, still searchable by name in ⌘K. Hiding never
    // disables: record links, in-app doors and openApp all still work.
    LAUNCHER_HIDDEN: ['goals', 'reader', 'bookmarks', 'actions', 'notes', 'calendar', 'prompts'],

    applyHiddenApps() {
        const hidden = this.getHiddenApps();

        // Static grid tiles only.
        document.querySelectorAll('.dash-apps-section .dash-app-tile[data-app]').forEach(tile => {
            if (tile.closest('#dash-favorite-apps-row')) return;
            if (tile.closest('#dash-locked-apps-row')) return;
            const app = tile.getAttribute('data-app');
            // Don't fight feature gating: a flag-off tile is already hidden
            // by FEATURES.applyToDocument and must stay that way.
            const gatedOff = typeof FEATURES !== 'undefined'
                && FEATURES.isGated(app) && !FEATURES.isEnabled(app);
            if (gatedOff) return;
            // A class, not inline display: nothing paints the registry now,
            // but Settings › Customize home apps still reads these tiles and
            // an inline style would win over any rule trying to show them.
            tile.classList.toggle('is-app-hidden', hidden.has(app));
            tile.style.display = '';
        });

        // Collapse a group whose every tile is now hidden so we don't
        // leave an orphan section header (e.g. "Money") with nothing under it.
        document.querySelectorAll('.dash-apps-section .dash-apps-group').forEach(group => {
            if (group.id === 'dash-favorite-apps-group') return;
            if (group.id === 'dash-locked-apps-group') return;
            const tiles = Array.from(group.querySelectorAll('.dash-app-tile[data-app]'));
            const anyVisible = tiles.some(t =>
                t.style.display !== 'none' && t.getAttribute('aria-hidden') !== 'true');
            group.style.display = anyVisible ? '' : 'none';
        });

        // The rail reads the same hidden set; repaint it here rather than at
        // each of this method's callers.
    },

    /**
     * Home. Threads is the home page (2026-10-11, by request: "retire the
     * now page and make Threads page the home page"): the name in the
     * titlebar, Back with no history, a notification's click, an empty hash
     * and every old "home" door land here. Home is the root of navigation,
     * so arriving resets the Back history. The old dashboard view (the Now
     * page, and the classic home before it) is gone from index.html.
     * @param {boolean} updateHash - Whether to update the URL hash (default: true)
     */
    showDashboard(updateHash = true) {
        if (typeof ThreadsPage !== 'undefined') ThreadsPage.mount();
        if (!this.apps.threads) { console.error('home: Threads is not mounted'); return; }
        this._navStack = [];
        if (this.currentApp === 'threads') { this.apps.threads.render?.(); if (typeof ThreadsPage !== 'undefined') ThreadsPage.closeSheet?.(); }
        else this.openAppFromLauncher('threads', updateHash);
        this._navStack = [];
    },

    /**
     * Setup navigation
     */
    setupNavigation() {
        // Cmd/Ctrl-click opens the target app in a new window instead of
        // switching the current window's view. Falls through to same-window
        // navigation if the multi-window IPC is unavailable (older preload).
        const openOrNewWindow = (appName, e) => {
            const newWindow = e && (e.metaKey || e.ctrlKey);
            if (newWindow && window.electronWindow?.openNew) {
                window.electronWindow.openNew(appName);
                return;
            }
            this.openAppFromLauncher(appName);
        };

        // Launcher tiles on the dashboard — replaces the old global
        // sidebar. Each tile has data-app pointing at the target view.
        // User-app tiles are excluded: they're recreated on hot reload, so
        document.querySelectorAll('.dash-app-tile[data-app]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const appName = el.dataset.app;
                if (appName) openOrNewWindow(appName, e);
            });
        });

        // (Titlebar Home button retired — the global nav's Feed item is
        // the way home.)

        // Per-app settings gears (.app-settings-btn in app headers): open
        // Settings on the category that configures that app, or the root
        // for apps without a dedicated category. One delegated listener —
        // the buttons are static header markup across many views.
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('.app-settings-btn');
            if (!btn) return;
            this.openAppSettings(btn.dataset.settingsFor);
        });

        // Theme toggle in titlebar
        const themeBtn = document.getElementById('theme-toggle-btn');
        if (themeBtn) {
            themeBtn.addEventListener('click', () => this.toggleTheme());
        }

        this.setupDashboardTabs();

        // Lock screen unlock button
        const unlockBtn = document.getElementById('lock-screen-unlock-btn');
        if (unlockBtn) {
            unlockBtn.addEventListener('click', () => this.promptUnlock());
        }

        // App picker
        this.setupAppPicker();

    },

    /**
     * Inject an "expand" icon into a Modal's header, left of the close button.
     * Clicking it runs `onExpand` (which should close the modal and open the
     * corresponding full-page editor).
     */
    _addModalExpand(modal, onExpand) {
        const header = modal.element.querySelector('.modal-header');
        if (!header) return;
        const closeBtn = header.querySelector('.modal-close');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'modal-expand';
        btn.title = 'Open full editor';
        btn.setAttribute('aria-label', 'Open full editor');
        btn.innerHTML = '&#10138;'; // ➚ expand to full view
        btn.onclick = onExpand;
        if (closeBtn) header.insertBefore(btn, closeBtn);
        else header.appendChild(btn);
    },



    appIcons: {
        actions: '☑', notes: '📝', goals: '🎯',
        schedule: '🕐',
        agent: '✨', settings: '⚙', help: '?'
    },

    setupAppPicker() {
        const pickerBtn = document.getElementById('app-picker-btn');
        const dropdown = document.getElementById('app-picker-dropdown');
        if (!pickerBtn || !dropdown) return;

        pickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('open');
            // Highlight current app
            dropdown.querySelectorAll('.app-picker-item').forEach(item => {
                item.classList.toggle('active', item.dataset.app === this.currentApp);
            });
        });

        dropdown.querySelectorAll('.app-picker-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                dropdown.classList.remove('open');
                const appName = item.dataset.app;
                if (appName === 'home') {
                    this.showDashboard();
                } else {
                    this.openAppFromLauncher(appName);
                }
            });
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
            dropdown.classList.remove('open');
        });
    },

    updateAppPicker(appName) {
        const picker = document.getElementById('app-picker');
        const icon = document.getElementById('app-picker-icon');
        if (!picker || !icon) return;

        icon.textContent = appName ? (this.appIcons[appName] || '') : '🏠';
        picker.style.display = '';
    },

    /**
     * Which Settings category configures each app. Apps without an entry
     * land on the Settings root — every gear still goes somewhere sane.
     */
    _settingsCategoryForApp: {
        agent: 'ai',
        // Finance's own panel (the AI writing switches) left 2026-10-09 with
        // the brief, profiles and headlines; its gear lands on the root.
        // Documents' ⋯ menu: the semantic model, index status, folder.
        reader: 'library',
    },

    // When an app's settings are one card on a shared panel, land ON the
    // card: scroll its heading into view and ring the card for a moment so
    // the eye finds it. Financial connections now open their Connectors page.
    _settingsAnchorForApp: {},

    openAppSettings(appName) {
        if (appName === 'spending' && typeof SimpleSettings !== 'undefined') {
            SimpleSettings.open('connector:institutions');
            return;
        }
        // A gear opens a category of the full Settings on purpose: say so,
        // or SettingsApp.render sees a bare root and hands the view to the
        // simple page (2026-10-06) before the category below opens — every
        // gear landed on the one Settings page instead of its card.
        if (typeof SettingsApp !== 'undefined') SettingsApp._intent = 'advanced';
        this.openApp('settings');
        // openApp renders Settings synchronously; category switch on next
        // tick so it lands after any root render.
        setTimeout(() => {
            if (typeof SettingsApp === 'undefined') return;
            const cat = this._settingsCategoryForApp[appName];
            if (cat) SettingsApp.openCategory(cat);
            else SettingsApp.showRoot?.();
            const anchor = this._settingsAnchorForApp[appName];
            if (anchor) this._landOnSettingsCard(anchor);
        }, 0);
    },

    _landOnSettingsCard({ head, card }) {
        const headEl = document.getElementById(head);
        const cardEl = document.getElementById(card);
        // The card is feature-gated (display:none when off) — nothing to
        // land on then; the panel itself is still the right place.
        if (!cardEl || cardEl.offsetParent === null) return;
        // Next frame: the panel became .active this tick and the scroll
        // container needs a layout before scrollIntoView can measure.
        requestAnimationFrame(() => {
            (headEl || cardEl).scrollIntoView({ block: 'start', behavior: 'smooth' });
            cardEl.classList.add('is-target');
            setTimeout(() => cardEl.classList.remove('is-target'), 2000);
        });
    },

    /**
     * The titlebar's sense of where you are. It still carries no location
     * label — every app states its own name in its page heading, and saying
     * it twice is the duplication we keep removing — but it does now carry
     * a way back: since 2026-08-05 the left slot names where you came FROM
     * ("← Assistant"), because a lot of navigation is a jump (a record link
     * in a chat, a door between Inbox and Email AI) and landing somewhere
     * used to mean losing the way back. With no history it reads Home, as
     * it always did; at home it renders nothing.
     *
     * The old name and its dozen call sites (openApp, showDashboard) stay;
     * renaming them buys nothing.
     */
    updateSidebarActive(appName) {
        const atHome = appName === 'home' || !appName;
        // The global left rail. This method is the one place that already
        // knows where we are, and every openApp/showDashboard passes
        // through it — so the rail cannot drift from the view on screen.
        if (typeof SimpleExperience !== 'undefined') SimpleExperience.onNavigate(appName);
        document.getElementById('titlebar-home')
            ?.classList.toggle('is-home', atHome);
        const backBtn = document.getElementById('titlebar-home-btn');
        if (!backBtn) return;
        const target = this._navStack[this._navStack.length - 1] || 'home';
        const toHome = target === 'home';
        // No "Home" button (2026-09-18, by request): the centred wordmark
        // already goes home, so Back shows only when it names an APP to
        // return to. With no history, the wordmark is the way out.
        backBtn.hidden = atHome || toHome;
        if (atHome || toHome) return;
        const label = toHome ? 'Home' : this.appLabel(target);
        const homeIcon = backBtn.querySelector('.titlebar-back-home-icon');
        const arrowIcon = backBtn.querySelector('.titlebar-back-arrow-icon');
        // toggleAttribute, not .hidden — these are SVG elements, and `hidden`
        // is an HTMLElement property SVGElement doesn't have, so assigning it
        // was a silent no-op and the house icon showed for every target.
        if (homeIcon) homeIcon.toggleAttribute('hidden', !toHome);
        if (arrowIcon) arrowIcon.toggleAttribute('hidden', toHome);
        const span = backBtn.querySelector('span');
        if (span) span.textContent = label;
        backBtn.title = toHome ? 'Home' : `Back to ${label}`;
    },

    /**
     * Step back to where the user came from. Pops the navigation stack;
     * 'home' (or an empty stack) goes to the dashboard. _navBack keeps the
     * retraced step from being pushed again, so back never ping-pongs.
     */
    goBack() {
        const target = this._navStack.pop();
        if (!target || target === 'home') { this.showDashboard(); return; }
        this._navBack = true;
        try { this.openApp(target); } finally { this._navBack = false; }
    },

    /**
     * Display name for an app id. Breadcrumb's label map first (it carries
     * the product names — 'fyi' is "Email AI"), then the registry tile
     * (covers packaged apps and anything Breadcrumb doesn't list), then the id
     * capitalized.
     */
    appLabel(appName) {
        if (typeof Breadcrumb !== 'undefined' && Breadcrumb.appLabels[appName]) {
            return Breadcrumb.appLabels[appName];
        }
        const tile = document.querySelector(
            `.dash-app-tile[data-app="${appName}"] .dash-app-tile-label`);
        const label = tile?.textContent?.trim();
        if (label) return label;
        return appName.charAt(0).toUpperCase() + appName.slice(1);
    },

    /**
     * Wire the dashboard tab bar (Apps / Feed). Persists the
     * current tab in localStorage so reopening home keeps the user's
     * choice. Defaults to "apps" — that's the launcher use case the
     * tile grid was designed for. (A stored legacy tab name, e.g. the
     * removed "widgets", falls back to "apps".)
     */
    setupDashboardTabs() {
        // Titlebar. The name is the way home (Threads) from anywhere. The
        // left slot is the Back button while you are inside an app
        // (updateSidebarActive hides it at home): it retraces the navigation
        // stack, and with no history it goes home — the name is a logo
        // first, and a logo is not where everyone looks for a way back.
        // Search opens ⌘K, which is also the app launcher.
        document.getElementById('titlebar-home')?.addEventListener('click', () => this.showDashboard());
        document.getElementById('titlebar-home-btn')?.addEventListener('click', () => this.goBack());
        document.getElementById('titlebar-search')?.addEventListener('click', () => CommandPalette?.show());
    },

    /**
     * Theme. localStorage 'theme' holds the PREFERENCE — 'light', 'dark', or
     * 'system' (follow macOS, added 2026-07-30). data-theme on <html> always
     * holds the RESOLVED light/dark value, so every [data-theme="dark"] CSS
     * override keeps working untouched. Machine-local on purpose: two Macs can
     * reasonably want different themes.
     */
    getThemePref() {
        const pref = localStorage.getItem('theme');
        return (pref === 'dark' || pref === 'system') ? pref : 'light';
    },

    setThemePref(pref) {
        if (!['light', 'dark', 'system'].includes(pref)) pref = 'light';
        localStorage.setItem('theme', pref);
        this._applyThemePref();
    },

    _applyThemePref() {
        const pref = this.getThemePref();
        const resolved = pref === 'system'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : pref;
        document.documentElement.setAttribute('data-theme', resolved);
    },

    setupTheme() {
        this._applyThemePref();
        // In System mode, track macOS appearance changes live (sunset, or a
        // manual flip in System Settings).
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (this.getThemePref() === 'system') this._applyThemePref();
        });
    },

    /**
     * Toggle dark/light theme (titlebar button + menu). A toggle is a demand
     * for the other look RIGHT NOW, so it always lands on an explicit
     * preference — leaving System mode if that's where the user was.
     */
    toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme');
        this.setThemePref(current === 'light' ? 'dark' : 'light');
    },

    /**
     * Setup menu bar action listeners
     */
    setupMenuActions() {
        window.electronMenu.onMenuAction((action) => {
            switch (action) {
                case 'settings':
                    this.showSettings();
                    break;
                case 'help':
                    this.showHelp();
                    break;
                case 'feedback':
                    this.showFeedback();
                    break;
                case 'check-updates':
                    this.showAppVersion({ check: true });
                    break;
                case 'toggle-theme':
                    this.toggleTheme();
                    break;
                case 'new-action':
                    // A new thing to do is said in nenva's thread (2026-10-11,
                    // Ram: "all the interactions with agent happens in threads").
                    if (typeof ThreadsPage !== 'undefined') { ThreadsPage.open('nenva'); ThreadsPage.newNenvaConversation(); }
                    break;
                case 'search':
                    CommandPalette?.show();
                    break;
                case 'reload':
                    // View › Reload and Cmd+R come here instead of doing a
                    // native reload, so the renderer can say what a reload
                    // would throw away. Force Reload (Cmd+Shift+R) still
                    // bypasses this entirely — the escape hatch stays.
                    this.requestReload();
                    break;
            }
        });
    },

    /**
     * Reload, unless it would destroy work.
     *
     * Cmd+R is a normal thing to press in this app: it is how a sync merge
     * happens (main.js merges on did-finish-load), and there was no other way
     * to ask for one. But every model call the app makes runs in this
     * renderer, so the habitual gesture also killed whatever the assistant,
     * a task run was in the middle of.
     *
     * Friction goes exactly where the cost is: with nothing at stake this
     * reloads instantly, unchanged. With work in flight it names the work and
     * offers the thing the user probably wanted anyway.
     */
    /**
     * What closing this window right now would cost, as copy for the native
     * confirm — or null when nothing is at stake. Reads the same registry as
     * requestReload so the two dialogs can never disagree.
     */
    _unloadGuard() {
        // Dirty editors first: a form that could not be auto-saved (a new
        // task without Save, a blank title) is the one thing closing
        // really loses.
        const dirty = typeof SaveStatus !== 'undefined' ? SaveStatus.dirtyLabels() : [];
        if (dirty.length) {
            return { title: 'Unsaved changes', message: 'Some edits could not be saved.',
                detail: dirty.map(l => '  • ' + l).join('\n') + '\n\nLeave anyway and lose them?' };
        }
        const have = typeof BackgroundWork !== 'undefined';
        const losable = have ? BackgroundWork.losable() : [];
        const pausable = have ? BackgroundWork.pausable() : [];
        if (!losable.length && !pausable.length) {
            return null;
        }
        const list = (items) => items.map(w => '  • ' + w.label).join('\n');
        const parts = [];
        if (losable.length) parts.push('Closing now would stop:\n' + list(losable));
        if (pausable.length) parts.push('Closing now would pause:\n' + list(pausable) + '\nPaused work starts again by itself next time.');
        return {
            title: 'Something is still running',
            message: losable.length ? 'The AI is still working.' : 'Work is still running.',
            detail: parts.join('\n\n') + '\n\nLeave anyway?'
        };
    },

    async requestReload() {
        const have = typeof BackgroundWork !== 'undefined';
        const losable = have ? BackgroundWork.losable() : [];
        // Work that survives the reload but that the user asked to hear about
        // anyway — a Re-analyze run. It gets its own sentence: telling someone
        // a reload will "stop" something that in fact continues is how the
        // dialog earns a reflex click.
        const pausable = have ? BackgroundWork.pausable() : [];
        if (!losable.length && !pausable.length) { window.location.reload(); return; }

        const section = (message, items) => items.length
            ? `<p class="confirm-message">${message}</p>
               <ul class="reload-work-list">${items.map(w => `<li>${this.escapeHtml(w.label)}</li>`).join('')}</ul>`
            : '';
        const content = `
            ${section('Reloading now would stop:', losable)}
            ${section('Reloading now would pause:', pausable)}
            ${pausable.length ? '<p class="settings-hint">Paused work starts again by itself once the app comes back.</p>' : ''}`;

        const buttons = [
            {
                text: 'Reload anyway',
                className: 'secondary-btn',
                onClick: () => { modal.close(); this._unloadConfirmed = true; window.location.reload(); }
            }
        ];
        buttons.push({
            text: 'Keep working',
            className: 'primary-btn',
            onClick: () => modal.close()
        });

        const modal = Modal.create({ title: 'Something is still running', className: 'confirm-dialog reload-dialog', content, buttons });
    },

    // Sync between Macs is retired (2026-09-30, docs/SYNC.md); what is left
    // is the backup key. A Mac whose backup key is passphrase-protected but
    // not unlocked here comes up LOCKED (backups paused), and one found on a
    // different key than iCloud's (`mismatch`) writes backups the passphrase
    // cannot open. Ask once at startup in either case.
    setupSyncIndicator() {
        if (!window.electronSync) return;
        this.promptSyncUnlockIfLocked();
    },

    async promptSyncUnlockIfLocked() {
        try {
            const st = await window.electronSync.encryptionStatus?.();
            if (!st || typeof SettingsApp === 'undefined') return;
            if (st.locked) await SettingsApp._syncEncPrompt('unlock');
            else if (st.mismatch) await SettingsApp._syncEncPrompt('recover');
        } catch { /* non-fatal — the Settings panel can still unlock */ }
    },

    /**
     * Briefly show a status message in the titlebar, reusing the sync
     * indicator slot. Used by background passes (sync merge, memory
     * consolidation) so the user sees that silent work happened.
     */
    flashTitlebarStatus(text) {
        const el = document.getElementById('sync-indicator');
        const textEl = document.getElementById('sync-indicator-text');
        if (!el || !textEl) return;

        textEl.textContent = text;
        el.style.display = '';
        el.classList.remove('fade-out');

        // Auto-hide after 8 seconds
        clearTimeout(this._syncIndicatorTimer);
        this._syncIndicatorTimer = setTimeout(() => {
            el.classList.add('fade-out');
            setTimeout(() => { el.style.display = 'none'; }, 600);
        }, 8000);
    },

    /**
     * Show settings (opens settings app view)
     */
    showSettings() {
        this.openApp('settings');
    },

    /**
     * Help (the menu bar's Help item). The Help app was removed 2026-10-07:
     * the assistant is the helper — it reads the app's own guide through
     * get_help (js/agent/help-docs.js) — so Help opens a fresh chat with the
     * cursor in its composer.
     */
    showHelp() {
        this.openAppFromLauncher('agent');
        if (this.currentApp !== 'agent' || typeof AgentUI === 'undefined') return;
        AgentUI.newChat();
        setTimeout(() => {
            const input = document.getElementById('agent-input');
            if (input) input.focus();
        }, 0);
    },

    /**
     * Straight to Settings › Send Feedback (menu bar's "Send Feedback…").
     * The deferred openCategory is the same dance every ⌘K settings hit
     * does: let the settings view render before drilling into the page.
     */
    showFeedback() {
        SimpleSettings.open('feedback');
    },

    /**
     * Straight to Settings › App version (menu bar's "Check for Updates…"),
     * optionally starting a check — the page draws the answer in place.
     */
    showAppVersion({ check = false } = {}) {
        SimpleSettings.open('about');
        if (check && typeof UpdaterUI !== 'undefined') setTimeout(() => UpdaterUI.checkNow(), 0);
    },

    /**
     * Show restore backup picker modal (used by SettingsApp)
     */
    async showRestoreBackupPicker() {
        try {
            const backups = await window.electronBackup.listBackups();
            if (backups.length === 0) {
                UIUtils.showToast('No backups found', 'warning');
                return;
            }

            const backupListHtml = backups.map((b, i) => {
                const date = new Date(b.modified);
                const sizeMB = (b.size / (1024 * 1024)).toFixed(2);
                const typeLabel = b.type === 'manual' ? 'Manual' : 'Auto';
                const typeBadgeColor = b.type === 'manual' ? 'var(--color-text)' : 'var(--color-text-tertiary)';
                return `
                    <div class="backup-item" data-index="${i}" style="display: flex; align-items: center; justify-content: space-between; padding: 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); cursor: pointer; transition: background 0.15s;">
                        <div style="flex: 1;">
                            <div style="font-size: var(--text-sm); color: var(--color-text);">
                                ${date.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
                                <span style="color: var(--color-text-secondary); margin-left: 0.25rem;">${date.toLocaleTimeString()}</span>
                            </div>
                            <div style="font-size: var(--text-xs); color: var(--color-text-tertiary); margin-top: 0.25rem;">
                                ${sizeMB} MB
                            </div>
                        </div>
                        <span style="font-size: var(--text-xs); padding: 0.15rem 0.5rem; border-radius: var(--radius-sm); background: ${typeBadgeColor}; color: var(--color-bg);">
                            ${typeLabel}
                        </span>
                    </div>`;
            }).join('');

            const pickerModal = Modal.create({
                title: 'Restore from Backup',
                className: 'modal-wide',
                content: `
                    <p style="color: var(--color-text-secondary); font-size: var(--text-sm); margin-bottom: 0.75rem;">
                        Select a backup to restore. This will replace all current data.
                    </p>
                    <div id="backup-list" style="display: flex; flex-direction: column; gap: 0.5rem; max-height: 300px; overflow-y: auto;">
                        ${backupListHtml}
                    </div>
                `,
                buttons: [{
                    text: 'Cancel',
                    className: 'secondary-btn',
                    onClick: () => pickerModal.close()
                }]
            });

            const items = document.querySelectorAll('.backup-item');
            items.forEach(item => {
                item.addEventListener('mouseenter', () => item.style.background = 'var(--color-surface-hover)');
                item.addEventListener('mouseleave', () => item.style.background = '');
                item.addEventListener('click', async () => {
                    const idx = parseInt(item.dataset.index);
                    const chosen = backups[idx];
                    const chosenDate = new Date(chosen.modified).toLocaleString();
                    pickerModal.close();

                    const confirmed = await UIUtils.confirm(
                        'Confirm Restore',
                        `Restore from ${chosen.type === 'manual' ? 'manual' : 'auto'} backup dated ${chosenDate}?\n\nThis will replace all current data. The app will reload after restore.`
                    );
                    if (!confirmed) return;

                    const result = await window.electronBackup.restore(chosen.path);
                    if (result.success) {
                        UIUtils.showToast('Restored from backup. Reloading...', 'success');
                        setTimeout(() => window.location.reload(), 1500);
                    } else {
                        UIUtils.showToast('Restore failed: ' + result.error, 'error');
                    }
                });
            });
        } catch (err) {
            UIUtils.showToast('Restore failed: ' + err.message, 'error');
        }
    },

    /**
     * Change storage location
     */
    async changeStorageLocation() {
        try {
            // Open folder selection dialog
            const folderPath = await window.electronDialog.selectFolder();

            if (!folderPath) {
                return; // User cancelled
            }

            // Check if path is writable
            const pathCheck = await window.electronDialog.checkPath(folderPath);
            if (!pathCheck.writable) {
                UIUtils.showToast('Selected folder is not writable', 'error');
                return;
            }

            // Check if data already exists at this location
            const existingData = await window.electronStore.checkDataAtPath(folderPath);

            if (existingData.exists && existingData.hasData) {
                // Ask user what to do
                const useExisting = await UIUtils.confirm(
                    'Data Found',
                    'Data already exists at this location. Would you like to use the existing data? Click "Confirm" to use existing data, or "Cancel" to migrate your current data (will overwrite).',
                    '📁'
                );

                if (useExisting) {
                    // Use existing data - don't migrate
                    const result = await window.electronStore.setCustomStoragePath(folderPath, false);
                    if (result.success) {
                        UIUtils.showToast('Storage location changed. Using existing data.', 'success');
                        setTimeout(() => window.location.reload(), 1500);
                    }
                    return;
                }
            }

            // Migrate data to new location
            const confirmed = await UIUtils.confirm(
                'Change Storage Location',
                `Your data will be moved to:\n${folderPath}\n\nThe app will reload after the change.`,
                '📁'
            );

            if (confirmed) {
                const result = await window.electronStore.setCustomStoragePath(folderPath, true);

                if (result.success) {
                    UIUtils.showToast('Storage location changed successfully!', 'success');
                    setTimeout(() => window.location.reload(), 1500);
                } else {
                    UIUtils.showToast('Failed to change storage location', 'error');
                }
            }
        } catch (error) {
            console.error('Error changing storage location:', error);
            UIUtils.showToast('Error changing storage location', 'error');
        }
    },

    /**
     * Reset storage location to default (Electron only)
     */
    async resetStorageLocation() {
        const confirmed = await UIUtils.confirm(
            'Reset Storage Location',
            'This will move your data back to the default location. The app will reload after the change.',
            '↩️'
        );

        if (confirmed) {
            try {
                const result = await window.electronStore.setCustomStoragePath(null, true);

                if (result.success) {
                    UIUtils.showToast('Storage location reset to default', 'success');
                    setTimeout(() => window.location.reload(), 1500);
                } else {
                    UIUtils.showToast('Failed to reset storage location', 'error');
                }
            } catch (error) {
                console.error('Error resetting storage location:', error);
                UIUtils.showToast('Error resetting storage location', 'error');
            }
        }
    },

    /** Something the person keeps changed: repaint what is on screen (Threads when it is up). */
    updateStats() {
        if (typeof SimpleExperience !== 'undefined') SimpleExperience.render();
    },

    /**
     * Setup authentication (Touch ID)
     */
    async setupAuth() {
        if (!window.electronAuth) return;

        try {
            this.authAvailable = await window.electronAuth.canPromptTouchID();
            this.authEnabled = await window.electronAuth.getAuthEnabled();
            this.autoLockTimeout = await window.electronAuth.getAutoLockTimeout();
        } catch (e) {
            this.authAvailable = false;
            this.authEnabled = false;
        }

        // Lock nenva is shared with the paired phone (synced `lock` key): a
        // flip there reaches here as a key change. Turning it on takes effect
        // at the next idle or launch; turning it off never unlocks a locked
        // screen (Touch ID still opens it).
        window.electronStore?.onKeyChanged?.(async (key) => {
            if (key != null && key !== 'app_lock') return;
            try {
                const was = this.authEnabled;
                this.authEnabled = await window.electronAuth.getAuthEnabled();
                this.autoLockTimeout = await window.electronAuth.getAutoLockTimeout();
                if (was === this.authEnabled) return;
                if (this.authEnabled) { this.lastActivityTime = Date.now(); this.startActivityTracking(); }
                else this.stopActivityTracking();
                if (typeof SimpleSettings !== 'undefined' && SimpleSettings._page === 'lock' && AppManager.currentApp === 'simplesettings') SimpleSettings.render();
            } catch { /* keep the current state */ }
        });

        // Listen for lock events from main process (Cmd+L, screen lock)
        window.electronAuth.onLockScreen(() => {
            if (this.authEnabled) this.lock();
        });

        // Only prompt Touch ID when nenva is actually in front. Auto-lock can
        // fire while the user is in another app (nenva sees no activity), and
        // a proactive promptTouchID there would pop the system dialog over the
        // app they're using. Instead we lock quietly and prompt when the window
        // regains focus. Guarded so a cancel→refocus doesn't loop.
        window.addEventListener('focus', () => {
            if (this.isLocked && this.authEnabled && this.authAvailable) {
                this._autoPromptUnlock();
            }
        });

        // If auth is enabled, lock on launch (window is focused → prompt is OK)
        if (this.authEnabled && this.authAvailable) {
            this.lock();
            this._autoPromptUnlock();
        }

        // Start activity tracking if auth is enabled
        if (this.authEnabled) {
            this.startActivityTracking();
        }
    },

    /**
     * Lock the app
     */
    lock() {
        if (this.isLocked) return;
        this.isLocked = true;
        // Allow exactly one auto-prompt for this lock (fired on focus); further
        // attempts go through the on-screen "Unlock with Touch ID" button.
        this._autoPrompted = false;

        const lockScreen = document.getElementById('lock-screen');
        if (lockScreen) {
            lockScreen.style.display = 'flex';
        }
        // Always show the "Unlock with Touch ID" button as the unlock affordance.
        // The macOS system prompt also auto-appears on launch/focus; while it's
        // on screen promptUnlock() hides this button so only the system prompt
        // shows, and reveals it again if that prompt is cancelled. Crucially,
        // when locking via Cmd+L the window stays focused (no focus event, so no
        // auto-prompt) — the button is then the user's way to start unlocking.
        const unlockBtn = document.getElementById('lock-screen-unlock-btn');
        if (unlockBtn) unlockBtn.style.display = '';

        this.stopActivityTracking();
    },

    /**
     * Auto-prompt Touch ID at most once per lock (used by launch + window
     * focus). The manual unlock button calls promptUnlock() directly to retry.
     */
    _autoPromptUnlock() {
        if (this._autoPrompted) return;
        this._autoPrompted = true;
        this.promptUnlock();
    },

    /**
     * Prompt Touch ID and unlock on success. Guarded against overlapping
     * prompts so a refocus while a prompt is already open can't stack dialogs.
     * Our in-app button stays hidden while the system prompt is up and is
     * revealed only as a retry if it's cancelled.
     */
    async promptUnlock() {
        if (!this.authAvailable || this._unlockInFlight) return;
        this._unlockInFlight = true;
        const unlockBtn = document.getElementById('lock-screen-unlock-btn');
        if (unlockBtn) unlockBtn.style.display = 'none';
        let ok = false;
        try {
            const result = await window.electronAuth.promptTouchID();
            ok = !!(result && result.success);
        } catch (e) {
            // User cancelled or Touch ID failed
        } finally {
            this._unlockInFlight = false;
        }
        if (ok) {
            this.unlock();
        } else if (this.isLocked && unlockBtn) {
            unlockBtn.style.display = '';   // reveal retry button
        }
    },

    /**
     * Unlock the app
     */
    unlock() {
        this.isLocked = false;

        const lockScreen = document.getElementById('lock-screen');
        if (lockScreen) {
            lockScreen.style.display = 'none';
        }

        this.lastActivityTime = Date.now();
        if (this.authEnabled) {
            this.startActivityTracking();
        }
    },

    /**
     * Reset the inactivity timer
     */
    resetActivityTimer() {
        this.lastActivityTime = Date.now();
    },

    /**
     * Start tracking user activity for auto-lock
     */
    startActivityTracking() {
        this.stopActivityTracking();

        this._activityHandler = () => this.resetActivityTimer();
        const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
        events.forEach(evt => document.addEventListener(evt, this._activityHandler, { passive: true }));

        // Check inactivity every 30 seconds
        this.activityCheckInterval = setInterval(() => {
            if (this.isLocked || !this.authEnabled) return;

            const idleMs = Date.now() - this.lastActivityTime;
            const timeoutMs = this.autoLockTimeout * 60 * 1000;

            if (idleMs >= timeoutMs) {
                // Lock quietly — do NOT prompt Touch ID here. The user may be
                // working in another app; the prompt fires when they return to
                // nenva (window focus) or click the unlock button.
                this.lock();
            }
        }, 30000);
    },

    /**
     * Stop tracking user activity
     */
    stopActivityTracking() {
        if (this._activityHandler) {
            const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
            events.forEach(evt => document.removeEventListener(evt, this._activityHandler));
            this._activityHandler = null;
        }
        if (this.activityCheckInterval) {
            clearInterval(this.activityCheckInterval);
            this.activityCheckInterval = null;
        }
    },

    /* ================================================================
     * App Lock (the per-app "sensitive apps" gate) was RETIRED 2026-10-07
     * (Ram: "like the suggestion for locked apps"): after the fold the
     * person sees Now · Chats · Memory · Settings, and a per-APP lock no
     * longer matched anything they could point at. The one lock is
     * "Lock nenva" (Touch ID at open and after idle, Settings › Privacy ›
     * Lock; `authEnabled` above). The guards that asked `isAppLocked`
     * (Now, the coach, the specialists) keep working: nothing is locked.
     * ================================================================ */
    isAppLocked() { return false; },
    getLockedApps() { return []; },
    canLockApp() { return false; },
    renderLockedApps() {},
    lockSensitiveNow() {},
    /**
     * Escape HTML to prevent XSS. Escapes quotes too, so the result is safe in
     * both text and attribute (title="…", href="…") contexts.
     */
    escapeHtml(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    /**
     * Setup schedule notifications (runs globally on app start)
     */
    setupScheduleNotifications() {
        if (!('Notification' in window)) return;

        if (Notification.permission === 'default') {
            Notification.requestPermission();
        }

        const notifiedToday = {};

        const checkAndNotify = () => {
            // Telegram forwarding is a second delivery lane: a
            // denied macOS permission must not silence reminders headed for
            // the phone.
            if (Notification.permission !== 'granted'
                && !(typeof Notify !== 'undefined' && Notify.forwardActive())) return;

            const now = new Date();
            const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const currentHH = now.getHours().toString().padStart(2, '0');
            const currentMM = now.getMinutes().toString().padStart(2, '0');
            const currentTime = `${currentHH}:${currentMM}`;

            // Reset notified set if it's a new day
            if (!notifiedToday[today]) {
                for (const key in notifiedToday) delete notifiedToday[key];
                notifiedToday[today] = new Set();
            }

            const notifiedSet = notifiedToday[today];
            // Commitments are the truth (2026-10-11): each open one's
            // occurrence today, at that day's own time (Commitments.timeOn).
            if (typeof Commitments === 'undefined' || !Commitments._inited) return;
            const all = Commitments.all();
            const nowMinutes = now.getHours() * 60 + now.getMinutes();

            const formatTime12 = (h, m) => {
                const p = h >= 12 ? 'PM' : 'AM';
                const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
                return `${h12}:${m.toString().padStart(2, '0')} ${p}`;
            };
            const timeRange = (t) => {
                if (!t || !t.time) return '';
                const [sh, sm] = t.time.split(':').map(Number);
                let s = formatTime12(sh, sm);
                if (t.end) { const [eh, em] = t.end.split(':').map(Number); s += ` - ${formatTime12(eh, em)}`; }
                return s;
            };
            const dayLabel = (iso) => {
                const d = new Date(iso + 'T00:00:00');
                return isNaN(d) ? iso : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
            };
            // What the commitment is about, the goal or project it is part
            // of, and the email it came from: enough to act on from a phone.
            const project = (c) => { const p = c.parent ? Commitments.get(c.parent) : null; return p && p.title ? p.title : ''; };
            const fromEmail = (c) => {
                const o = c.origin || {};
                return (o.kind === 'email' || o.kind === 'text') && (o.from || o.subject) ? [o.from, o.subject].filter(Boolean).join(' · ') : '';
            };
            const phoneFacts = (c, whenLine) => {
                const f = { type: 'commitment', title: c.title, when: whenLine, details: String(c.note || '').replace(/\s+/g, ' ').trim().slice(0, 400) };
                if (project(c)) f.project = project(c);
                if (fromEmail(c)) f.from = `email: ${fromEmail(c)}`;
                return f;
            };
            const reminderBody = (c, whenLine) => {
                const lines = [whenLine];
                const desc = String(c.note || '').replace(/\s+/g, ' ').trim();
                if (desc) lines.push(desc.length > 160 ? desc.slice(0, 159).trimEnd() + '…' : desc);
                if (project(c)) lines.push(`Part of: ${project(c)}`);
                if (fromEmail(c)) lines.push(`From email: ${fromEmail(c)}`);
                if (Array.isArray(c.tags) && c.tags.length) lines.push(`Tags: ${c.tags.join(', ')}`);
                return lines.filter(Boolean).join('\n');
            };
            const say = (c, when) => Notify.show(c.title, reminderBody(c, when), { kind: 'reminder', phone: phoneFacts(c, when) });

            for (const c of all) {
                if (!c || c.state !== 'open') continue;
                const repeats = Commitments.repeats(c);
                const date = c.when && c.when.date;
                const remind = c.remind || {};

                // A one-time dated commitment: the day itself at 9:00, and
                // any days before it the person asked for.
                if (!repeats && date && date >= today) {
                    const daysUntil = Math.round((new Date(date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
                    const days = [0, ...((remind.daysBefore || []).filter(n => n > 0))];
                    const key = `${c.id}_advance_${daysUntil}`;
                    if (days.includes(daysUntil) && currentTime === '09:00' && !notifiedSet.has(key)) {
                        notifiedSet.add(key);
                        let when = daysUntil === 0 ? 'Due today' : daysUntil === 1 ? `Due tomorrow, ${dayLabel(date)}` : `Due in ${daysUntil} days, ${dayLabel(date)}`;
                        const tr = timeRange(Commitments.timeOn(c, date));
                        if (tr) when += ` at ${tr}`;
                        say(c, when);
                    }
                }

                // Today's occurrence at its clock time.
                const forToday = repeats ? Commitments.occursOn(c, today) : date === today;
                if (!forToday || Commitments.isDone(c, today) || (c.history && c.history[today] === 'dropped')) continue;
                const t = Commitments.timeOn(c, today);
                if (!t || !t.time) continue;   // untimed: the 9:00 notice above is its reminder
                const [sh, sm] = t.time.split(':').map(Number);
                const before = Number(remind.minutesBefore) || 0;
                // Keyed by the time too: a day moved to the evening still rings at the new time.
                if (before > 0 && nowMinutes === sh * 60 + sm - before && !notifiedSet.has(`${c.id}@${t.time}_early`)) {
                    notifiedSet.add(`${c.id}@${t.time}_early`);
                    say(c, `Starting in ${before} min, today at ${timeRange(t)}`);
                }
                if (t.time === currentTime && !notifiedSet.has(`${c.id}@${t.time}`)) {
                    notifiedSet.add(`${c.id}@${t.time}`);
                    say(c, `Starting now, today at ${timeRange(t)}`);
                }
            }
        };

        // Check every 30 seconds
        setInterval(checkAndNotify, 30000);
        checkAndNotify();
    },

};
