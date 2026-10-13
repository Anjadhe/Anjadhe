/**
 * SimSources (renderer half) — simulated mail and texts on a TEST instance
 * (js/main/sim-sources.js has the laws, SS1–SS4). Inert unless main says
 * the simulation is active (ANJADHE_DATA_ROOT and ANJADHE_SIM=1).
 *
 * It does two small things and nothing else:
 *   - a simulated message pushed by main (`sim-mail-arrived`) is handed to
 *     EmailApp.receiveEmails, the function the Gmail syncs call, as new
 *     mail this session (it may notify, like real new mail);
 *   - a simulated text, queued in main, is picked up by IMessageSource's
 *     own tick (the same poll that reads chat.db), nudged here so a test
 *     does not wait for the poll.
 *
 * From devtools or a harness:
 *   SimSources.arrive({ kind: 'email', at: '0d 08:12', from: 'Harbor Mutual <service@harbormutual.example>', subject: '…', body: '…' })
 *   SimSources.arrive({ kind: 'text', at: '0d 16:48', handle: '+15125550142', chatName: 'Bright Smile Dental', text: '…' })
 *   SimSources.play('threads-demo', { step: 'A4.lakeside' })   // one step of a scenario file
 *   SimSources.play('threads-demo', { upTo: 0 })                // every step dated today or earlier
 */
const SimSources = {
    _on: false,

    async init() {
        if (!window.electronSim || this._on) return;
        let st = null;
        try { st = await window.electronSim.status(); } catch { st = null; }
        if (!st || !st.active) return;
        this._on = true;
        window.electronSim.onMail((emails) => this._mail(emails));
        console.info('[sim] simulated sources are on (test instance)');
    },

    get active() { return this._on; },

    async _mail(emails) {
        if (typeof EmailApp === 'undefined' || !Array.isArray(emails) || !emails.length) return;
        try {
            if (!EmailApp._dataLoaded) await EmailApp.loadData();
            const r = await EmailApp.receiveEmails(emails, { notify: true });
            console.info(`[sim] ${emails.length} email(s) arrived: ${r.arrived} new, ${r.queued} queued for analysis`);
            if (typeof EmailApp.drainAnalysisQueue === 'function') EmailApp.drainAnalysisQueue();
        } catch (e) { console.warn('[sim] mail did not land:', e && e.message); }
    },

    async arrive(step) {
        if (!this._on) return { ok: false, error: 'simulation is off' };
        const r = await window.electronSim.arrive(step);
        if (r && r.ok && step && step.kind === 'text') this._tickTexts();
        return r;
    },

    async play(name, opts) {
        if (!this._on) return { ok: false, error: 'simulation is off' };
        const r = await window.electronSim.play(name, opts || {});
        this._tickTexts();
        return r;
    },

    _tickTexts() {
        try { if (typeof IMessageSource !== 'undefined' && IMessageSource.enabled && IMessageSource.enabled()) IMessageSource.tick('sim'); } catch { /* the poll picks it up */ }
    }
};

if (typeof module !== 'undefined') module.exports = SimSources;
