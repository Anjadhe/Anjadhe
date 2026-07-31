/**
 * StarterPrompts — out-of-the-box prompt notes seeded once per install.
 *
 * A fresh install gets a small set of ready-made background prompts (Daily
 * Briefing, News Digest, Daily Motivation, Weekly Reflection) so the home
 * feed demonstrates itself without the user authoring anything. They are
 * ordinary prompt notes — editable, reschedulable, deletable.
 *
 * Idempotency: ids are fixed (so any sync-convergence path collapses to one
 * copy) and a synced `starter-prompts` flag key records WHICH ids have been
 * seeded (per-id since 2026-07-30, so starters added in updates reach
 * existing installs) — a Mac that merges the flag never re-seeds those ids,
 * and deleting a starter never resurrects it.
 *
 * All except the Daily Briefing get their `promptFeed.runs` stamp
 * pre-filled at seed time, anchoring them to their scheduled times instead
 * of all firing on the first scheduler pass. The briefing is left unstamped
 * on purpose: one immediate post (once a model is ready) shows what the
 * feed is for.
 */
const StarterPrompts = {
    KEY: 'starter-prompts',

    ITEMS: [
        {
            id: 'starter-daily-briefing',
            title: 'Daily Briefing',
            config: { offline: true, interval: 'daily', time: '08:00', web: false, useContext: true },
            runImmediately: true,
            body: 'Write my morning briefing. Look at my tasks, goals, and calendar: list what is due or scheduled today (with times where known), call out anything overdue I should clear or reschedule, and note what is coming up tomorrow. Keep it short and scannable — a few bullets — and end with the single thing that matters most today.'
        },
        {
            id: 'starter-news-digest',
            title: 'Morning News',
            // Moved from 17:00 to the morning on 2026-07-29, when the home
            // Discover pane was removed: the feed post is now the thing that
            // greets you with the news, so it should be there before the day
            // starts rather than at the end of it. Seeding is one-shot, so
            // installs that already have this prompt keep their 17:00 time
            // until the user edits it in Manage prompts.
            config: { offline: true, interval: 'daily', time: '07:00', web: true, useContext: false },
            // Reads the user's OWN topics via get_news rather than searching
            // the web: the headlines come back real, dated and sourced, so
            // the model is summarising given text instead of recalling world
            // events — the difference between a digest a 12B model can do
            // well and one it cannot.
            body: 'Call get_news to fetch the headlines for the topics I follow, then write my morning news digest from them. Group the stories by topic, one or two sentences each, and name the source. Only use the headlines the tool returned — never add stories from memory. Lead with whatever is most significant. If the tool says the headlines are stale, say how old they are instead of calling them today’s news. If it returns nothing, say so in one line.'
        },
        {
            id: 'starter-daily-motivation',
            title: 'Daily Motivation',
            config: { offline: true, interval: 'daily', time: '09:00', web: false, useContext: true },
            body: 'Write a short piece of daily motivation that is actually about me. Look at my open tasks and goals — especially anything overdue, stuck, or marked need-help — and write a few encouraging lines that acknowledge what I am working through, then give one concrete, doable suggestion for today. Vary the style day to day: sometimes a fitting quote, sometimes a reframe, sometimes a tiny challenge. Never generic filler.'
        },
        {
            id: 'starter-weekly-reflection',
            title: 'Weekly Reflection',
            config: { offline: true, interval: 'weekly', time: '18:00', web: false, useContext: true },
            body: 'Help me reflect on my week. Review my tasks, goals, and journal: what got completed, what slipped or kept getting pushed, and which goals moved forward or stalled. Write a short, honest reflection — wins first, then patterns worth noticing — and end with three specific questions worth thinking about for next week.'
        },
        // Portfolio reviews (added 2026-07-30): the strategy/insights UI moved
        // out of the Portfolio app and into these scheduled agent runs. All
        // three run through the assistant (useContext) so the read-only
        // portfolio tools ground every number; weekdays only — markets are
        // closed on weekends and a review of nothing is noise. Skipped
        // entirely when there is no portfolio data (the prompt bodies say to
        // stay silent, and an empty list_portfolio makes that cheap).
        {
            id: 'starter-portfolio-premarket',
            title: 'Pre-Market Review',
            config: { offline: true, interval: 'weekdays', time: '07:30', web: false, useContext: true },
            body: 'Write my pre-market portfolio review. First call list_portfolio; if I hold nothing, reply with one quiet line saying there is nothing to review and stop. Otherwise call refresh_portfolio_prices, then get_news and pull out only the headlines that touch my holdings or their industries — use only headlines the tool returned, never stories from memory. Note any pre-market moves on my positions. Keep it to a few short bullets and end with two or three specific things worth watching today.'
        },
        {
            id: 'starter-portfolio-midday',
            title: 'Midday Market Check',
            config: { offline: true, interval: 'weekdays', time: '12:30', web: false, useContext: true },
            body: 'Do a midday check on my portfolio. Call list_portfolio, then refresh_portfolio_prices. Report only the positions moving 2% or more today and what they are doing to my total. If nothing is moving that much, say the portfolio is quiet in one line and stop — do not pad it.'
        },
        {
            id: 'starter-portfolio-close',
            title: 'Market Close Review',
            config: { offline: true, interval: 'weekdays', time: '16:30', web: false, useContext: true },
            body: 'Write my market-close review. Call list_portfolio and refresh_portfolio_prices, then summarize the day: total change, my best and worst positions, and my cash position. Then call check_strategy and state plainly whether I am on plan, using only its computed numbers — name any drift or breach without lecturing. End with anything genuinely worth discussing, or nothing if the day was unremarkable. If I hold nothing, reply with one quiet line and stop.'
        }
    ],

    seed() {
        if (typeof NotePrompts === 'undefined' || typeof StorageManager === 'undefined') return;

        // Per-id diff (was a one-shot flag until 2026-07-30): each starter id
        // seeds exactly once per install, so starters added in an update
        // reach existing installs too. The flag only ever grows — "deleting a
        // starter never resurrects it" still holds per id, and a stale flag
        // merging in from a not-yet-updated Mac just re-runs the diff against
        // the notes-id guard below, which makes it a no-op.
        const seeded = new Set(StorageManager.get(this.KEY)?.ids || []);
        const toSeed = this.ITEMS.filter(it => !seeded.has(it.id));
        if (!toSeed.length) return;

        const notes = NotePrompts._readNotes();
        const existing = new Set(notes.map(n => n.id));
        const now = new Date().toISOString();
        const fresh = toSeed.filter(it => !existing.has(it.id)).map(it => ({
            id: it.id,
            title: it.title,
            content: NotePrompts._bodyToHtml(it.body),
            tags: [],
            template: 'prompt',
            prompt: { ...NotePrompts.DEFAULTS, ...it.config },
            pinned: false,
            createdAt: now,
            modifiedAt: now
        }));
        if (fresh.length) NotePrompts._writeNotes([...fresh, ...notes]);

        // Anchor every newly seeded starter except run-immediately ones to
        // their scheduled time — otherwise the first scheduler pass would
        // fire them all at once (or, on an upgrade, the moment the app
        // boots). Already-seeded ids keep whatever stamp they have.
        const feed = StorageManager.get('promptFeed') || {};
        const runs = (feed.runs && typeof feed.runs === 'object') ? feed.runs : {};
        for (const it of toSeed) {
            if (!it.runImmediately && !runs[it.id]) runs[it.id] = now;
        }
        StorageManager.set('promptFeed', { items: Array.isArray(feed.items) ? feed.items : [], runs });

        StorageManager.set(this.KEY, { ids: [...seeded, ...toSeed.map(it => it.id)] });
    }
};
