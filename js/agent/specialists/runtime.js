/* What a workroom agent's run is held to, in code rather than in a prompt.
 *
 * The guard is THREE rules and nothing it knows is hidden from the model:
 * every stop reason below is also in the tool result the model just read.
 *   1. The same call, same arguments, same answer, three times, is not
 *      progress — on a page or off one.
 *   2. A page that needs the user (a human check, a field only they may
 *      fill) stops the run; so does a step they declined.
 *   3. The step and time budgets, which AgentLoop owns.
 * It replaced a state machine (needsImage / needsLookup / previewClose) that
 * filtered the tool list and refused actions for reasons the model was never
 * told — one live run spent 52 actions in it without a single click landing.
 */
const SpecialistRuntime = {
    urls(text) {
        const urls = new Set();
        for (const raw of String(text || '').match(/https?:\/\/[^\s<>"'`]+/g) || []) {
            try {
                let value = raw.replace(/[.,;]+$/, '');
                while (value.endsWith(')') && (value.match(/\)/g) || []).length > (value.match(/\(/g) || []).length) value = value.slice(0, -1);
                const url = new URL(value);
                if (/^https?:$/.test(url.protocol) && !url.username && !url.password) urls.add(url.href);
            } catch { /* prose, not a usable URL */ }
        }
        return [...urls];
    },
    /** Links a tool result actually produced: the only ones a report may cite as sources. */
    sourceUrls(name, args, result) {
        if (!result || result.error || result.denied || result.cancelled || result.isError) return [];
        if (name === 'web_search') return this.urls((result.results || []).map(item => item.url || '').join('\n'));
        if (name === 'read_url') return this.urls(result.url || args?.url || '');
        if (name === 'browser_look' || name === 'browser_act') return this.urls(result.url || '');
        return [];
    },
    createGuard() {
        return {
            last: null, repeats: 0,
            /** Returns a stop reason `{ reason, message }`, or null to carry on. */
            observe(name, args, result) {
                if (!result) return null;
                if (result.cancelled) return { reason: 'cancelled', message: 'The workroom was paused.' };
                if (result.denied) return { reason: 'permission', message: 'You declined a step, so I stopped there. Nothing was done on that step.' };
                if (result.blocker) return { reason: 'manual', message: String(result.blocker) };
                if (result.manualRequired || /only the user can/i.test(result.stepError || result.error || '')) {
                    return { reason: 'manual', message: 'This page needs something only you can enter (a sign-in, a code or payment details). Open Browser here in the chat, take control, do that part, then Continue.' };
                }
                // Rule 1 is not only about pages. A data specialist that asks
                // the same question and gets the same answer over and over is
                // not making progress either: one calendar run spent 22
                // identical reads, then wrote up meetings it no longer had.
                const page = name === 'browser_act' || name === 'browser_look';
                const shape = page
                    ? [result.url, result.position, result.controls, result.text, result.stepError || result.error || null]
                    : [JSON.stringify(result ?? null).slice(0, 4000)];
                const key = JSON.stringify([name, args, ...shape]);
                this.repeats = key === this.last ? this.repeats + 1 : 0;
                this.last = key;
                if (this.repeats >= 2) {
                    return { reason: 'no_progress', message: page
                        ? 'The same step kept leaving the page unchanged, so I stopped instead of repeating it.'
                        : `I called ${name} with the same arguments three times and got the same answer, so I stopped instead of repeating it.` };
                }
                return null;
            }
        };
    },
    _visionChecks: new Map(),
    /* Can this model actually READ a picture? Asked once per model with four
     * synthetic digits, before any real page is ever sent as an image. A
     * model that fails simply works from the numbered list. */
    async verifyVision(entry, call) {
        const key = JSON.stringify([entry?.id, entry?.engine, entry?.model, entry?.baseUrl]);
        const known = this._visionChecks.get(key);
        if (known && known.at > Date.now() - 30 * 60000) return known.ok;
        let ok = false;
        try {
            const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), n => n % 10).join('');
            const canvas = document.createElement('canvas'); canvas.width = 360; canvas.height = 130;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 360, 130);
            ctx.fillStyle = '#111'; ctx.font = 'bold 72px sans-serif'; ctx.fillText(code, 70, 90);
            const response = await call([{ role: 'user', content: [{ type: 'text', text: 'Read the four digits in this image. Reply with the digits only.' },
                { type: 'image_url', image_url: { url: canvas.toDataURL('image/png') } }] }]);
            ok = !response?.error && String(response?.message?.content || '').replace(/\D/g, '') === code;
        } catch { ok = false; }
        this._visionChecks.set(key, { ok, at: Date.now() });
        return ok;
    }
};
if (typeof module !== 'undefined') module.exports = SpecialistRuntime;
