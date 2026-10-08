/**
 * Portfolio's preferences, asked with taps instead of Settings switches
 * (2026-10-02, docs/AI_NATIVE.md phase 4, js/core/pref-asks.js). The person's
 * answer is a sentence in Memory › Preferences; PortfolioApp.aiWritingEnabled
 * and headlinesEnabled read it.
 *
 *   portfolio-brief      default ON (as before). Asked once a brief or a
 *                        profile has been written: keep writing one?
 *   portfolio-headlines  default OFF (as before: it reads a third-party site
 *                        and spends model calls). Offered once the person has
 *                        opened Portfolio on three days. Learned: on, and not
 *                        looked at for 14 days → offer to stop.
 * A choice made with the old switches carries over once, as its sentence.
 */
(function () {
    if (typeof PrefAsks === 'undefined') return;
    const DAYS_KEY = 'portfolio-open-days';
    const SEEN_KEY = 'portfolio-headlines-seen';
    const days = () => { try { return JSON.parse(localStorage.getItem(DAYS_KEY) || '[]'); } catch { return []; } };

    PrefAsks.register({
        id: 'portfolio-brief', order: 30, default: true,
        question: 'I wrote a market brief and stock profiles on your Portfolio page. Keep writing them?',
        why: 'A short read each day on the market and what you hold.',
        choices: [
            { value: true, label: 'Yes, keep them', sentence: 'Write me a daily market brief and stock profiles for my portfolio.' },
            { value: false, label: 'No thanks', sentence: "Don't write market briefs or stock profiles for my portfolio." }
        ],
        ready: () => {
            try { return typeof PortfolioBrief !== 'undefined' && Object.keys(PortfolioBrief.cache() || {}).length > 0; } catch { return false; }
        }
    });
    PrefAsks.register({
        id: 'portfolio-headlines', order: 35, default: false,
        question: "Want CNBC's market headlines summarised on your Portfolio page?",
        why: 'Refreshed while the page is open. Your symbols go to your AI model with the headlines.',
        choices: [
            { value: true, label: 'Yes, show them', sentence: "Summarise CNBC's market headlines on my Portfolio page." },
            { value: false, label: 'No thanks', sentence: "Don't fetch CNBC headlines for my portfolio." }
        ],
        ready: () => days().length >= 3
    });

    // Carry over a choice made with the old Settings switches, once.
    try {
        const s = StorageManager.get('portfolio-settings') || {};
        if (s.aiWriting === false && !PrefAsks.answered('portfolio-brief')) PrefAsks.set('portfolio-brief', false, { quiet: true });
        if (s.headlines === true && !PrefAsks.answered('portfolio-headlines')) PrefAsks.set('portfolio-headlines', true, { quiet: true });
    } catch { /* nothing to carry */ }

    window.PortfolioPrefs = {
        /** A day the person opened Portfolio (for when to offer headlines). */
        noteOpened() {
            const d = new Date().toISOString().slice(0, 10);
            const list = days();
            if (list.includes(d)) return;
            list.push(d);
            try { localStorage.setItem(DAYS_KEY, JSON.stringify(list.slice(-30))); } catch { /* fine */ }
        },
        /** The headlines were on screen; if they go unseen for two weeks, offer to stop. */
        noteHeadlinesSeen() { try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* fine */ } },
        checkHeadlinesUse() {
            if (PrefAsks.value('portfolio-headlines') !== true) return;
            const seen = Number(localStorage.getItem(SEEN_KEY) || 0) || Date.now();
            if (!localStorage.getItem(SEEN_KEY)) this.noteHeadlinesSeen();
            if (Date.now() - seen > 14 * 86400000) {
                PrefAsks.suggest('portfolio-headlines', false, "You haven't looked at the CNBC headlines in two weeks. Stop fetching them?");
            }
        }
    };
    setTimeout(() => window.PortfolioPrefs.checkHeadlinesUse(), 30000);
})();
