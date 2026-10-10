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
            // Phone<->Mac channel: main never connects to the relay on its
            // own — it waits for this call, which only happens with the
            // mobilesync release flag on. Main also checks the flag before
            // starting either channel.
            if (FEATURES.isEnabled('mobilesync') && window.electronChannel?.ensure) {
                window.electronChannel.ensure();
            }
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
        // Assistant to the top of the nav/switcher (2026-08-08): unhide it
        // once for installs that had hidden the old "Do"-group tile.
        try { this.unhideAgentOnce(); } catch (e) { console.warn('[apps] agent unhide failed:', e); }
        // Default-hidden launcher set (still searchable by name) — must run
        // before applyHiddenApps paints the nav.
        try { this.seedDefaultHiddenOnce(); } catch (e) { console.warn('[apps] default-hidden seed failed:', e); }
        try { this.simplifyLauncherOnce(); } catch (e) { console.warn('[apps] launcher simplify failed:', e); }
        // A local model picked on the setup page starts downloading once
        // the app is up (consume-once; see resumeSetupDownload).
        setTimeout(() => { try { this.resumeSetupDownload(); } catch (e) { console.warn('[setup] resume download failed:', e); } }, 2000);

        // IMPORTANT: handleRoute MUST run before updateStats. The empty-state
        // redirect inside updateWelcome (called from updateStats) opens the
        // About app, which rewrites window.location.hash and clobbers the
        // hash we'd otherwise restore. Routing first sets currentApp to the
        // user's actual app, then the updateWelcome guard "currentApp !== null"
        // suppresses the redirect entirely. This cost users their app on every
        // page refresh until it was reordered.
        this.handleRoute();
        this.updateStats();
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
        // list has to be loaded before the engine reads it, and whatever the
        // notes blob still holds of the old shape moves over first.
        if (typeof AgentService !== 'undefined' && AgentService.loadConversations) AgentService.loadConversations();
        if (typeof NotePrompts !== 'undefined' && NotePrompts.migrateFromNotes) {
            try { NotePrompts.migrateFromNotes(); } catch (e) { console.warn('[routines] move from notes failed:', e?.message || e); }
        }
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
            // The old health log becomes tracking commitments, once (2026-10-05).
            if (typeof WellnessFold !== 'undefined') WellnessFold.runOnce();
            if (typeof CommitmentsPage !== 'undefined') CommitmentsPage.mount();
            if (typeof WorkPlans !== 'undefined') WorkPlans.init();
        }

        // Tasks the person taught by showing them (docs/TEACH.md): each one
        // is a playbook the Browser agent reads, so they load before any job.
        if (typeof TaughtTasks !== 'undefined') { try { TaughtTasks.init(); } catch (e) { console.warn('[taught-tasks] init failed:', e?.message); } }

        // Notes + Journal as Markdown files in ~/nenva/ — projection out,
        // outside edits in. Same rule: started here, never from a view.
        if (typeof ContentFiles !== 'undefined') ContentFiles.init();
        // The Journal app left nenva (2026-10-05): one final export of every
        // entry to ~/nenva/Journal and a notice, once per Mac.
        if (typeof JournalExport !== 'undefined') JournalExport.runOnce();
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
        // Phone chat — the same remote-answer rule, on our own encrypted
        // phone<->Mac channel (see js/agent/mobile-channel.js).
        if (typeof MobileChannel !== 'undefined') MobileChannel.init();
        // Mac-served phone views (email insights, news, portfolio digests).
        if (typeof MobileViews !== 'undefined') MobileViews.init();


        // Setup authentication
        await this.setupAuth();
        // A locked-apps set from before 2026-10-07 becomes Lock nenva, once.
        this._carryAppLockOnce();

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

        // Hide dashboard
        document.getElementById('dashboard-view').classList.remove('active');

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
                    registrationStatus.textContent = 'Your free license is saved on this Mac.';
                }
                startBtn.textContent = 'Starting…';
                await applyModel();
                // Web search stays unset until the assistant's first search asks
                // (see the note above); the cloud brain's Connect key must not
                // read as a choice.
                try { await window.electronSearch?.askFirst?.(); } catch { /* older main */ }
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

        // First boot after onboarding: land in the Assistant (the one
        // blade), never the 12-app grid. One-shot — cleared immediately so
        // later navigation behaves normally. We deliberately do NOT seed a
        // prompt: on a fresh install there are no tasks and no connected
        // inbox, so a data-dependent prompt would visibly no-op. Just open
        // the assistant and focus the empty input so the user can start.
        try {
            if (localStorage.getItem('anjadhe_land_assistant') === '1') {
                localStorage.removeItem('anjadhe_land_assistant');
                if (this.apps['agent']) {
                    this.openApp('agent', false);
                    this._clearInitialLoader();
                    setTimeout(() => {
                        try {
                            const input = (typeof AgentUI !== 'undefined' && AgentUI.getInput)
                                ? AgentUI.getInput()
                                : document.getElementById('dash-agent-input');
                            if (input) input.focus();
                        } catch {}
                    }, 150);
                    return;
                }
            }
        } catch {}

        if (hash === '' || hash === 'home') {
            this.showDashboard(false);
            this._clearInitialLoader();
            return;
        }

        // Retired page (2026-10-07): old bookmarks and restored windows
        // land on Settings instead of leaving the window without a view.
        if (hash === 'more-apps') {
            if (typeof SimpleSettings !== 'undefined') SimpleSettings.open('root');
            else this.openApp('settings');
            this._clearInitialLoader();
            return;
        }

        const parts = hash.split('/');
        // The old Plan tab's app id — #focus hashes (bookmarks, refreshes
        // from before the rename) land on the Goals page; area deep-links
        // (#focus/focus/<id>) degrade to the Goals home since areas are gone.
        const appName = parts[0] === 'focus' ? 'goals' : parts[0];
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
        // The standalone Tasks page was absorbed by the Actions hub (Tasks
        // tab); 'focus' was the Plan tab's app id before it became the Goals
        // page (2026-07-31). Old callers and hashes land on the new doors.
        if (appName === 'schedule') return this.openApp('actions', updateHash);
        if (appName === 'focus') return this.openApp('goals', updateHash);
        // The Calendar page left 2026-10-05: today and the week are on Now.
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
    _LEGACY_RECENT_APPS_KEY: 'recent-apps',
    _FREQUENT_APPS_MAX: 6,

    /** `{ [app]: { count, last } }` — raw, unsorted, never null. */
    getAppUsage() {
        try {
            const raw = JSON.parse(localStorage.getItem(this._APP_USAGE_KEY) || 'null');
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
        } catch { /* corrupt or absent — fall through to the migration */ }

        // One-time lift from the old recents list, so the first launch after
        // updating is not a blank ⌘K. Position stands in for both count and
        // recency: most recent gets the highest seed.
        const out = {};
        try {
            const legacy = JSON.parse(localStorage.getItem(this._LEGACY_RECENT_APPS_KEY) || '[]');
            if (Array.isArray(legacy)) {
                legacy.filter(a => typeof a === 'string').forEach((app, i) => {
                    out[app] = { count: Math.max(1, legacy.length - i), last: legacy.length - i };
                });
            }
        } catch { /* nothing to migrate */ }
        return out;
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
            localStorage.removeItem(this._LEGACY_RECENT_APPS_KEY);
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

    renderFavoriteApps() {
        const section = document.getElementById('dash-favorite-apps-group');
        const row = document.getElementById('dash-favorite-apps-row');
        if (!section || !row) return;

        const favorites = this.getFavoriteApps();
        const hiddenApps = this.getHiddenApps();
        // Map to existing tile DOM so icons/labels/badges stay in sync with
        // the canonical grid below. Skip apps whose tile doesn't exist
        // (removed or gated-off), gated apps whose flag is currently off,
        // and apps the user has hidden from their home page.
        const tiles = [];
        for (const appName of favorites) {
            if (!appName) continue;
            if (typeof FEATURES !== 'undefined' && FEATURES.isGated(appName) && !FEATURES.isEnabled(appName)) continue;
            if (hiddenApps.has(appName)) continue;
            // Find the canonical tile elsewhere in the apps section to copy.
            const canonical = document.querySelector(
                `.dash-apps-section .dash-app-tile[data-app="${appName}"]:not(#dash-favorite-apps-row .dash-app-tile)`
            );
            if (!canonical) continue;
            tiles.push(canonical);
        }

        if (tiles.length === 0) {
            section.style.display = 'none';
            row.innerHTML = '';
            return;
        }

        // Rebuild row. Clone the canonical tile so badges/feature flags
        // come along; strip the id on the clone to avoid duplicates.
        row.innerHTML = '';
        for (const tile of tiles) {
            const clone = tile.cloneNode(true);
            clone.removeAttribute('id');
            // Re-id any descendant with an id to prevent duplicate ids
            // (e.g., #dash-email-badge). Drop the id; badge text gets
            // re-synced by updateStats() on dashboard show.
            clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
            // Customize acts on the canonical tile. Once the sheet has been
            // opened, the canonical tiles carry .tile-edit controls, and a
            // deep clone brings them along — so a second open showed star
            // and Hide buttons on the shortcut rows too, editing an app from
            // two places at once.
            clone.querySelectorAll('.tile-edit').forEach(el => el.remove());
            row.appendChild(clone);
        }

        // Re-bind clicks — the generic delegation in setupAppTileNavigation
        // runs once at startup, so clones added later need their own handler.
        row.querySelectorAll('.dash-app-tile[data-app]').forEach(el => {
            el.addEventListener('click', () => {
                const appName = el.getAttribute('data-app');
                if (appName) this.openApp(appName);
            });
        });

        section.style.display = '';
    },

    /* ----------------------------------------------------------------
     * Customize home apps. We ship many apps; this lets a user hide the
     * ones they don't use. Stored via StorageManager (so the curated set
     * follows them across Macs — unlike usage counts, which are a
     * usage pattern and stay machine-local). Hiding an app keeps it out of
     * ⌘K's empty-query list; it stays findable by name (GlobalSearch.apps).
     * ---------------------------------------------------------------- */
    _HIDDEN_APPS_KEY: 'hidden-apps',

    getHiddenApps() {
        const d = StorageManager.get(this._HIDDEN_APPS_KEY);
        return new Set(Array.isArray(d?.apps) ? d.apps : []);
    },

    setHiddenApps(set) {
        // Spread keeps one-shot migration stamps (see unhideAgentOnce) —
        // a plain {apps} write would wipe them and re-run the migration.
        const d = StorageManager.get(this._HIDDEN_APPS_KEY) || {};
        StorageManager.set(this._HIDDEN_APPS_KEY, { ...d, apps: Array.from(set) });
    },

    /**
     * One-shot (2026-08-08): the assistant moved to its own tier at the top
     * of the nav/switcher, BY REQUEST — an install that hid the old "Do"
     * tile would render the new tier invisible and the change would look
     * like it never shipped. Unhide it once; the stamp (preserved by
     * setHiddenApps) means a user who hides it again stays hidden.
     */
    unhideAgentOnce() {
        const d = StorageManager.get(this._HIDDEN_APPS_KEY) || {};
        if (d.agentUnhidden2026_08 || !Array.isArray(d.apps) || !d.apps.includes('agent')) {
            if (!d.agentUnhidden2026_08 && Array.isArray(d.apps)) {
                StorageManager.set(this._HIDDEN_APPS_KEY, { ...d, agentUnhidden2026_08: true });
            }
            return;
        }
        StorageManager.set(this._HIDDEN_APPS_KEY, {
            ...d,
            apps: d.apps.filter(a => a !== 'agent'),
            agentUnhidden2026_08: true
        });
    },

    /**
     * One-shot (2026-08-21, by request): Wellness, AI
     * Activity, Help and About leave the default launcher set — they are
     * reference/occasional surfaces, still reachable by name in ⌘K. The stamp (preserved by setHiddenApps) means a user who
     * re-enables one stays enabled; hiding never disables (⌘K by name,
     * record links and openApp all still work).
     */
    // Bundled packages append themselves via manifest `hiddenByDefault`
    // (Wellness, Portfolio, News — since 2026-09-02) before
    // seedDefaultHiddenOnce runs.
    DEFAULT_HIDDEN_APPS: [],

    seedDefaultHiddenOnce() {
        const d = StorageManager.get(this._HIDDEN_APPS_KEY) || {};
        if (d.defaultHidden2026_08) return;
        const apps = new Set(Array.isArray(d.apps) ? d.apps : []);
        for (const id of this.DEFAULT_HIDDEN_APPS) apps.add(id);
        StorageManager.set(this._HIDDEN_APPS_KEY, {
            ...d,
            apps: Array.from(apps),
            defaultHidden2026_08: true
        });
    },

    /**
     * One-shot (2026-10-01, by request): ONE small launcher for everyone.
     * Testers said the app "looks like an OS" and that they needed to learn
     * a lot before it did anything for them, so the launcher now holds the
     * assistant, Insights, Routines and Settings (Tasks and Notes, then
     * Calendar, left in later steps the same day); the rest stay searchable
     * by name in ⌘K. Existing installs get it too (Ram:
     * "even for existing installs we can give the same simplified refined
     * experience"), with ONE exception: an app this Mac opened in the last
     * 30 days stays where its user left it, because hiding the Journal of
     * someone who writes in it every night is a regression, not a
     * simplification. Hiding never disables — ⌘K by name, record links,
     * in-app doors (Tasks › Plan for Projects) and openApp all still work.
     * The stamp (kept by setHiddenApps) means a user who re-enables an app
     * stays enabled.
     */
    // Each step runs once per Mac under its own stamp, so a later step
    // reaches a Mac that already ran an earlier one without re-hiding what
    // its user turned back on. Add a step; never edit a shipped one.
    SIMPLE_LAUNCHER_STEPS: [
        // Routines ('prompts') was in this list until the same day it was
        // given a Home button (unreleased then, so the step was edited).
        { stamp: 'simpleLauncher2026_10', apps: ['goals', 'journal', 'reader', 'bookmarks', 'news',
            'wellness', 'portfolio', 'spending', 'aiactivity', 'help', 'about'] },
        // Notes and Tasks too (2026-10-01, Ram: "lets disable notes, tasks
        // apps by deafult. if they want they can enable it"). The launcher
        // is the assistant, Insights (Email) and Calendar; tasks the email
        // read creates still surface on Home's "On your radar".
        { stamp: 'simpleLauncher2026_10b', apps: ['actions', 'notes'] },
        // Calendar too (same day, Ram: "lets disable calendar app also by
        // default"). Upcoming events still show on Home's "On your radar".
        { stamp: 'simpleLauncher2026_10c', apps: ['calendar'] },
        // Routines too (2026-10-06, the simplification, docs/VISION.md): a
        // routine is a Standing chat on the Chats page, so the app has no
        // launcher door. Its detail still opens from there.
        { stamp: 'simpleLauncher2026_10d', apps: ['prompts'] }
    ],
    get SIMPLE_LAUNCHER_HIDDEN() {
        return this.SIMPLE_LAUNCHER_STEPS.flatMap(step => step.apps);
    },
    SIMPLE_LAUNCHER_RECENT_MS: 30 * 86400000,

    simplifyLauncherOnce(now = Date.now()) {
        const d = StorageManager.get(this._HIDDEN_APPS_KEY) || {};
        const pending = this.SIMPLE_LAUNCHER_STEPS.filter(step => !d[step.stamp]);
        if (!pending.length) return;
        const usage = this.getAppUsage();
        const apps = new Set(Array.isArray(d.apps) ? d.apps : []);
        const stamps = {};
        for (const step of pending) {
            for (const id of step.apps) {
                // `last` is a timestamp; the legacy-recents lift seeds small
                // integers, which are position, not recency, and keep nothing.
                const last = usage[id]?.last || 0;
                if (last > 1e12 && now - last < this.SIMPLE_LAUNCHER_RECENT_MS) continue;
                apps.add(id);
            }
            stamps[step.stamp] = true;
        }
        StorageManager.set(this._HIDDEN_APPS_KEY, { ...d, apps: Array.from(apps), ...stamps });
    },

    applyHiddenApps() {
        const hidden = this.getHiddenApps();

        // Static grid tiles only — never the Favourites row clones, which
        // are rebuilt from these and filtered separately in renderFavoriteApps.
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
     * Show dashboard
     * @param {boolean} updateHash - Whether to update the URL hash (default: true)
     */
    showDashboard(updateHash = true) {
        // Dismiss the docked AI panel — it's anchored to the page it was
        // opened over and shouldn't linger over the dashboard.
        if (typeof AgentUI !== 'undefined' && AgentUI.isOpen) AgentUI.close();
        // Hide all views
        this._notifyAppHidden();
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
        });
        // #setup-view is shown via an inline display style (bypassing the
        // .active class), so clear it here too — otherwise the first-run
        // wizard bleeds through behind the dashboard.
        const setupView = document.getElementById('setup-view');
        if (setupView) setupView.style.display = 'none';

        // Show dashboard
        const dashboard = document.getElementById('dashboard-view');
        if (dashboard) {
            dashboard.classList.add('active');
            this.currentApp = null;
            // Home is the root of navigation — arriving here (wordmark, back
            // button, deep-link fallback) resets the Back history.
            this._navStack = [];
            this.updateAppPicker(null);
            this.updateSidebarActive('home');
            document.body.classList.remove('in-sub-app');

            window.scrollTo(0, 0);
            document.querySelector('#dashboard-view .dash-main')?.scrollTo(0, 0);
            this.renderDashHeader();
            // Widgets are what the apps are holding for the user. Async and
            // unawaited — the rest of home must not wait on a price cache or
            // a SQLite count. Cards that resolve to nothing never appear.
            if (typeof Widgets !== 'undefined') {
                Widgets.render(document.getElementById('dash-widgets'));
            }
            // Feed is the home stage — refresh it on every return so new
            // scheduled-run posts and profile changes show without Cmd+R.
            if (typeof PromptFeed !== 'undefined') PromptFeed.render();
            this.updateStats();
            this.applyHiddenApps();
            this.renderFavoriteApps();
            this.renderLockedApps();

            // Paint the assistant readiness dot in the home chat box (and keep
            // it live while the model is loading). Read-only — no warm here; the
            // warm fires when the user actually focuses the chat box.
            if (typeof AgentUI !== 'undefined' && AgentUI.startReadinessWatch) {
                AgentUI.startReadinessWatch();
            }
            if (updateHash) {
                if (window.location.hash.slice(1) !== '') this._queueRouteEcho('');
                window.location.hash = '';
            }
        }
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

        // Dashboard "Ask nenva" input — route to Agent with a new conversation.
        // Always start fresh so a dashboard question doesn't hijack an ongoing
        // thread the user had open in the Agent view. Reuses the Agent's own
        // sendMessage path (streaming, tool calls, persistence) rather than
        // trying to duplicate it here.
        const dashAgentInput = document.getElementById('dash-agent-input');
        const dashAgentSend = document.getElementById('dash-agent-send-btn');
        const submitDashAgent = () => {
            const text = dashAgentInput?.value?.trim() || '';
            // Attachment-only sends are fine — same rule as the chat composer.
            const hasAttachments = typeof AgentUI !== 'undefined' && AgentUI.pendingAttachments?.length > 0;
            if (!text && !hasAttachments) return;
            dashAgentInput.value = '';
            if (typeof AgentUI !== 'undefined') AgentUI._autoGrowComposer?.(dashAgentInput);
            if (typeof AgentService !== 'undefined') AgentService.openFreshConversation();
            this.openApp('agent');
            // Defer until Agent view has rendered its input. AppManager.openApp
            // calls render() synchronously, but some fields (e.g. the textarea
            // autosize) wire up on next tick — requestAnimationFrame is the
            // least surprising moment to populate + fire.
            requestAnimationFrame(() => {
                // Use AgentUI.getInput() — the full-app view uses
                // #agent-app-input, the floating panel uses #agent-input, and
                // getInput() picks the right one based on AgentUI.mode (which
                // renderAppView sets to 'app' moments before this fires).
                const agentInput = (typeof AgentUI !== 'undefined') ? AgentUI.getInput() : null;
                if (agentInput && typeof AgentUI !== 'undefined') {
                    agentInput.value = text;
                    AgentUI.sendMessage();
                }
            });
        };
        dashAgentSend?.addEventListener('click', submitDashAgent);
        dashAgentInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitDashAgent();
            }
        });
        // Focusing the home chat box is intent to chat — warm the model so it's
        // resident by the time the user sends, and reflect its state in the dot.
        dashAgentInput?.addEventListener('focus', () => {
            if (typeof AgentService !== 'undefined') AgentService.warmOnIntent?.();
            if (typeof AgentUI !== 'undefined') AgentUI.startReadinessWatch?.();
        });
        // Quick-start pills under the composer (day-stable; render once —
        // the set deliberately never reshuffles mid-session).
        if (typeof AgentUI !== 'undefined') AgentUI.renderDashSuggestions?.();

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

    /**
     * Where should a globally captured action link? Only when the user is
     * LOOKING at a goal/area right now — and even then it's surfaced as a
     * visible, dismissible chip in the modal, never linked invisibly.
     */
    _captureContext() {
        try {
            // The open commitment's sheet (the Projects page is gone, phase 5b).
            if (this.currentApp === 'commitments' && typeof CommitmentsPage !== 'undefined' && CommitmentsPage._open) {
                const meta = LinkManager.getItemMeta('goals', CommitmentsPage._open);
                if (meta) return { app: 'goals', itemId: CommitmentsPage._open, label: meta.title };
            }
        } catch { /* context is a nicety — capture must never fail over it */ }
        return null;
    },

    /**
     * Global quick capture: add an action from anywhere (File → New
     * Action, Cmd+Shift+N). Full natural-language parse with live
     * chips ("call dentist tomorrow 3pm"), an explicit context chip when a
     * goal/area is on screen, and a View toast that jumps to Actions.
     */
    quickCreateTask() {
        if (typeof ScheduleApp === 'undefined' || typeof Modal === 'undefined') return;

        let ctx = this._captureContext();

        const form = document.createElement('div');
        form.className = 'quick-capture';
        form.innerHTML = `
            <input type="text" class="quick-capture-title" placeholder="What needs doing? e.g., Call dentist tomorrow 3pm" autocomplete="off" />
            <div class="quick-capture-preview schedule-quick-add-preview" hidden></div>
            ${ctx ? `<div class="quick-capture-context">&#8594; <span class="quick-capture-context-label"></span><button type="button" class="quick-capture-context-remove" title="Don't link" aria-label="Don't link">&times;</button></div>` : ''}
            <div class="quick-capture-hint">Lands in Today unless you say when · Enter to save · &#8984;&#8679;N</div>
        `;
        const titleEl = form.querySelector('.quick-capture-title');
        const previewEl = form.querySelector('.quick-capture-preview');
        if (ctx) {
            // textContent (not innerHTML) — goal titles are user data.
            form.querySelector('.quick-capture-context-label').textContent = ctx.label;
            form.querySelector('.quick-capture-context-remove').onclick = (e) => {
                ctx = null;
                e.target.closest('.quick-capture-context').remove();
            };
        }

        const modal = Modal.create({
            title: 'New action',
            className: 'quick-capture-modal',
            content: form,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                { text: 'Add action', className: 'primary-btn', onClick: () => save() }
            ]
        });

        const save = () => {
            const raw = titleEl.value.trim();
            if (!raw) return;
            const id = ScheduleApp.quickAddDetached(raw, { silent: true });
            if (!id) return; // quickAddTask already toasted why (e.g. no name)
            if (ctx) LinkManager.addLink(ctx.app, ctx.itemId, 'schedule', id);
            const item = ScheduleApp.scheduleItems.find(i => i.id === id);
            const isToday = item && item.scheduledDate === ScheduleApp.getLocalToday();
            modal.close();
            UIUtils.showToast(`Action added${isToday ? ' to Today' : ''}`, 'success', 4000, {
                actionLabel: 'View',
                onAction: () => this.openApp('actions')
            });
            // Refresh whichever list the user is looking at.
            if (this.currentApp === 'actions' && typeof ActionsApp !== 'undefined') ActionsApp.render();
            else if (this.currentApp === 'schedule') ScheduleApp.render();
        };
        // Expand: carry the PARSED title into the full task editor.
        const expand = () => {
            const parsed = ScheduleQuickParse.parse(titleEl.value.trim(), ScheduleApp.getLocalToday());
            modal.close();
            // updateHash:false — see quickCreateNote; openEditor sets the
            // detail hash itself via replaceState (no hashchange fired).
            this.openApp('schedule', false);
            ScheduleApp.openEditor(null, { title: parsed.title.trim() });
        };
        this._addModalExpand(modal, expand);
        titleEl.addEventListener('input', () => {
            const raw = titleEl.value.trim();
            if (!raw) { previewEl.hidden = true; previewEl.innerHTML = ''; return; }
            const parsed = ScheduleQuickParse.parse(raw, ScheduleApp.getLocalToday());
            if (!parsed.hasParse) { previewEl.hidden = true; previewEl.innerHTML = ''; return; }
            const chips = parsed.chips.map(c =>
                `<span class="schedule-parse-chip">${UIUtils.escapeHtml(c.label)}</span>`).join('');
            const title = parsed.title.trim()
                ? `<span class="schedule-parse-preview-title">&#8594; <strong>${UIUtils.escapeHtml(parsed.title.trim())}</strong></span>`
                : `<span class="schedule-parse-preview-title">Add a task name</span>`;
            previewEl.innerHTML = chips + title;
            previewEl.hidden = false;
        });
        titleEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
        });
        requestAnimationFrame(() => titleEl.focus());
    },

    appIcons: {
        actions: '☑', notes: '📝', goals: '🎯',
        schedule: '🕐', portfolio: '📊',
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
        // No Apps/Feed tabs anymore: the left nav owns app launching and
        // the feed is the permanent home stage. (Name kept for the caller.)
        // Titlebar. The wordmark is the way home from anywhere; at home it
        // returns the stream to the top, which is the only thing left for
        // "home" to mean there. The left slot is the Back button while you
        // are inside an app (updateSidebarActive hides it at home): it
        // retraces the navigation stack, and with no history it goes home —
        // the wordmark is a logo first, and a logo is not where everyone
        // looks for a way back. Search opens ⌘K, which is also the app
        // launcher now that the Apps sheet is gone.
        document.getElementById('titlebar-home')?.addEventListener('click', () => {
            if (this.currentApp) { this.showDashboard(); return; }
            document.querySelector('#dashboard-view .dash-main')
                ?.scrollTo({ top: 0, behavior: 'smooth' });
        });
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
                    this.quickCreateTask();
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

    /**
     * Update dashboard stats
     */
    // --- Dashboard rendering ---

    renderDashHeader() {
        const now = new Date();
        const hour = now.getHours();
        let greeting = 'Good morning';
        if (hour >= 12 && hour < 17) greeting = 'Good afternoon';
        else if (hour >= 17) greeting = 'Good evening';

        const greetingEl = document.getElementById('dash-greeting');
        if (greetingEl) greetingEl.textContent = greeting;

        const dateEl = document.getElementById('dash-date-line');
        if (dateEl) {
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const months = ['January', 'February', 'March', 'April', 'May', 'June',
                           'July', 'August', 'September', 'October', 'November', 'December'];
            dateEl.textContent = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}`;
        }

    },

    updateStats() {
        // All panels updated here live on the dashboard. When the user is on
        // an app view they're invisible, so recomputing them is wasted work
        // that slows every page refresh and every in-app save. showDashboard()
        // resets currentApp to null and re-calls updateStats() when the user
        // navigates home, so panels are always fresh when actually viewed.
        if (this.currentApp !== null) return;

        if (typeof SimpleExperience !== 'undefined') SimpleExperience.render();

        this.renderAnnouncements();
        this.updateWelcome();
    },


    updateWelcome() {
        // No-op. We used to redirect a data-empty home dashboard to the
        // About page, but the empty-data first experience is now owned by
        // the post-onboarding Assistant landing — yanking the user to About on every empty-state
        // dashboard render fought that flow. Kept as a stub so existing
        // callers (updateStats → updateWelcome) stay valid.
    },

    async renderAnnouncements() {
        const container = document.getElementById('dash-announcements');
        if (!container) return;

        let announcements = [];
        try {
            const cfg = await window.electronConfig.get();
            announcements = Array.isArray(cfg?.announcements) ? cfg.announcements : [];
        } catch {}

        const dismissed = new Set((StorageManager.get('dismissed-announcements')?.ids) || []);
        const visible = announcements.filter(a => a && a.id && !dismissed.has(a.id));

        if (visible.length === 0) {
            container.style.display = 'none';
            container.innerHTML = '';
            return;
        }

        container.style.display = '';
        container.innerHTML = '';

        for (const a of visible) {
            const card = document.createElement('div');
            card.className = 'dash-announcement';

            const body = document.createElement('div');
            body.className = 'dash-announcement-body';

            if (a.title) {
                const titleEl = document.createElement('div');
                titleEl.className = 'dash-announcement-title';
                titleEl.textContent = a.title;
                body.appendChild(titleEl);
            }

            if (a.body) {
                const textEl = document.createElement('div');
                textEl.className = 'dash-announcement-text';
                textEl.textContent = a.body;
                body.appendChild(textEl);
            }

            if (a.link && a.link.url && a.link.label) {
                const linkEl = document.createElement('button');
                linkEl.className = 'dash-announcement-link';
                linkEl.textContent = a.link.label;
                linkEl.onclick = () => {
                    if (window.electronAuth && window.electronAuth.openExternal) {
                        window.electronAuth.openExternal(a.link.url);
                    }
                };
                body.appendChild(linkEl);
            }

            const close = document.createElement('button');
            close.className = 'dash-announcement-close';
            close.title = 'Dismiss';
            close.setAttribute('aria-label', 'Dismiss announcement');
            close.innerHTML = '&times;';
            close.onclick = () => this.dismissAnnouncement(a.id);

            card.appendChild(body);
            card.appendChild(close);
            container.appendChild(card);
        }
    },

    dismissAnnouncement(id) {
        const current = StorageManager.get('dismissed-announcements') || {};
        const ids = Array.isArray(current.ids) ? current.ids.slice() : [];
        if (!ids.includes(id)) ids.push(id);
        StorageManager.set('dismissed-announcements', { ids });
        this.renderAnnouncements();
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
     * Lock; `authEnabled` above). The synced `app-lock` blob is left as
     * user data, unread; a Mac that had apps locked turns Lock nenva on
     * once (`_carryAppLockOnce`). The guards that asked `isAppLocked`
     * (Now, the coach, the specialists) keep working: nothing is locked.
     * ================================================================ */
    isAppLocked() { return false; },
    getLockedApps() { return []; },
    canLockApp() { return false; },
    renderLockedApps() {},
    lockSensitiveNow() {},
    /** Once per Mac: a locked-apps set from before 2026-10-07 becomes Lock nenva, where this Mac can lock at all. */
    async _carryAppLockOnce() {
        try {
            if (localStorage.getItem('app-lock-carried')) return;
            const d = StorageManager.get('app-lock') || {};
            const had = Array.isArray(d.apps) && d.apps.length > 0;
            if (had && this.authAvailable && !this.authEnabled && window.electronAuth) {
                this.authEnabled = true;
                await window.electronAuth.setAuthEnabled(true);
                this.lastActivityTime = Date.now();
                this.startActivityTracking?.();
                if (typeof UIUtils !== 'undefined') UIUtils.showToast('Locked apps became Lock nenva: Touch ID when nenva opens. Change it under Settings › Privacy › Lock.', 'info', 9000);
            }
            localStorage.setItem('app-lock-carried', '1');
        } catch (e) { console.warn('[app-lock] carry-over failed:', e); }
    },

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
            const data = StorageManager.get('schedule');
            const items = data?.scheduleItems || [];
            const dayOfWeek = now.getDay();

            // Convert current time to total minutes for comparison
            const nowMinutes = now.getHours() * 60 + now.getMinutes();

            const formatTime12 = (h, m) => {
                const p = h >= 12 ? 'PM' : 'AM';
                const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
                return `${h12}:${m.toString().padStart(2, '0')} ${p}`;
            };
            const timeRange = (item) => {
                if (!item.startTime) return '';
                const [sh, sm] = item.startTime.split(':').map(Number);
                let s = formatTime12(sh, sm);
                if (item.endTime) {
                    const [eh, em] = item.endTime.split(':').map(Number);
                    s += ` - ${formatTime12(eh, em)}`;
                }
                return s;
            };
            const dayLabel = (iso) => {
                const d = new Date(iso + 'T00:00:00');
                return isNaN(d) ? iso : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
            };
            // The one builder of a reminder's body: the "when" line the
            // caller worked out, then what the task is about (description
            // snippet), which project it belongs to, and the email it came
            // from. Forwarded to a phone, a bare "9:00 AM" said nothing;
            // this says enough to act on without opening the app.
            // The phone's facts for this reminder (PhoneReach writes the message).
            const phoneFacts = (item, whenLine) => {
                const f = { type: 'commitment', title: item.title, when: whenLine, details: String(item.description || '').replace(/\s+/g, ' ').trim().slice(0, 400) };
                try {
                    const goalIds = (LinkManager.getLinksFor('schedule', item.id).goals || []).map(l => l.itemId);
                    const goals = (StorageManager.get('goals')?.goals || []).filter(g => goalIds.includes(g.id) && g.title);
                    if (goals.length) f.project = goals.map(g => g.title).join(', ');
                } catch { /* no links */ }
                if (item.source === 'email' && (item.sourceEmailFrom || item.sourceEmailSubject)) f.from = `email: ${[item.sourceEmailFrom, item.sourceEmailSubject].filter(Boolean).join(' · ')}`;
                return f;
            };
            const reminderBody = (item, whenLine) => {
                const lines = [whenLine];
                const desc = String(item.description || '').replace(/\s+/g, ' ').trim();
                if (desc) lines.push(desc.length > 160 ? desc.slice(0, 159).trimEnd() + '…' : desc);
                try {
                    const goalIds = (LinkManager.getLinksFor('schedule', item.id).goals || []).map(l => l.itemId);
                    const goals = (StorageManager.get('goals')?.goals || []).filter(g => goalIds.includes(g.id) && g.title);
                    if (goals.length) lines.push(`Project: ${goals.map(g => g.title).join(', ')}`);
                } catch { /* links unavailable — the reminder still says the rest */ }
                if (item.source === 'email' && (item.sourceEmailFrom || item.sourceEmailSubject)) {
                    lines.push(`From email: ${[item.sourceEmailFrom, item.sourceEmailSubject].filter(Boolean).join(' · ')}`);
                }
                if (Array.isArray(item.tags) && item.tags.length) lines.push(`Tags: ${item.tags.join(', ')}`);
                return lines.filter(Boolean).join('\n');
            };

            for (const item of items) {
                // Abandoned = resolved, like completed: no reminders. A
                // one-time task is resolved by any abandoned mark; recurring
                // tasks only for the abandoned day's occurrence.
                const oneTimeAbandoned = (!item.repeat || item.repeat === 'none')
                    && !!item.history && Object.values(item.history).includes('abandoned');

                // --- Multi-day advance reminders (for items with reminderDaysBefore) ---
                if (item.reminderDaysBefore?.length && item.scheduledDate && item.lastCompletedDate !== today && !oneTimeAbandoned) {
                    const dueDate = new Date(item.scheduledDate + 'T00:00:00');
                    const todayDate = new Date(today + 'T00:00:00');
                    const daysUntilDue = Math.round((dueDate - todayDate) / (1000 * 60 * 60 * 24));

                    // Check if today matches any of the reminder days
                    if (item.reminderDaysBefore.includes(daysUntilDue)) {
                        // Fire advance reminder at 9:00 AM
                        const reminderKey = `${item.id}_advance_${daysUntilDue}`;
                        if (currentTime === '09:00' && !notifiedSet.has(reminderKey)) {
                            notifiedSet.add(reminderKey);
                            let when;
                            if (daysUntilDue === 0) {
                                when = `Due today`;
                            } else if (daysUntilDue === 1) {
                                when = `Due tomorrow, ${dayLabel(item.scheduledDate)}`;
                            } else {
                                when = `Due in ${daysUntilDue} days, ${dayLabel(item.scheduledDate)}`;
                            }
                            const tr = timeRange(item);
                            if (tr) when += ` at ${tr}`;
                            Notify.show(item.title, reminderBody(item, when), { kind: 'reminder', phone: phoneFacts(item, when) });
                        }
                    }
                }

                // --- Standard same-day notifications ---
                // Check if item is for today
                let isForToday = true;
                switch (item.repeat) {
                    case 'daily': break;
                    case 'weekdays': isForToday = dayOfWeek >= 1 && dayOfWeek <= 5; break;
                    case 'weekly': isForToday = item.dayOfWeek === dayOfWeek; break;
                    case 'custom': isForToday = (item.repeatDays || []).includes(dayOfWeek); break;
                    default: {
                        if (item.lastCompletedDate && item.lastCompletedDate !== today) {
                            isForToday = false;
                        } else {
                            const itemDate = item.scheduledDate || (item.createdAt ? item.createdAt.slice(0, 10) : today);
                            isForToday = itemDate === today;
                        }
                        break;
                    }
                }
                if (!isForToday) continue;

                // Check if already completed or abandoned today
                if (item.lastCompletedDate === today) continue;
                if (oneTimeAbandoned) continue;
                if (item.history && item.history[today] === 'abandoned') continue;

                // Untimed tasks have no clock time — they get advance-day
                // reminders (handled above) but no time-of-day notification.
                if (!item.startTime) continue;

                const [sh, sm] = item.startTime.split(':').map(Number);
                const startMinutes = sh * 60 + sm;
                const notifyBefore = item.notifyBefore || 0; // minutes before
                const notifyAt = startMinutes - notifyBefore;

                // Notification for the early reminder
                // Keyed by the time too: a task moved to this evening after
                // its morning reminder rang still rings at the new time.
                if (notifyBefore > 0 && nowMinutes === notifyAt && !notifiedSet.has(item.id + '@' + item.startTime + '_early')) {
                    notifiedSet.add(item.id + '@' + item.startTime + '_early');

                    const early = `Starting in ${notifyBefore} min, today at ${timeRange(item)}`;
                    Notify.show(item.title, reminderBody(item, early), { kind: 'reminder', phone: phoneFacts(item, early) });
                }

                // Notification at the exact start time
                if (item.startTime === currentTime && !notifiedSet.has(item.id + '@' + item.startTime)) {
                    notifiedSet.add(item.id + '@' + item.startTime);

                    const nowLine = `Starting now, today at ${timeRange(item)}`;
                    Notify.show(item.title, reminderBody(item, nowLine), { kind: 'reminder', phone: phoneFacts(item, nowLine) });
                }
            }
        };

        // Check every 30 seconds
        setInterval(checkAndNotify, 30000);
        checkAndNotify();
    },

};
