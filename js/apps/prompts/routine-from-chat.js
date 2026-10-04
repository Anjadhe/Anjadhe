/**
 * RoutineFromChat — "Repeat this…" on an answer that already worked.
 *
 * docs/ROUTINES_UX.md P3, door 1 of U1. The native gesture for making a
 * routine is not "new routine" and never was; it is *"do that again every
 * morning"*. Every routine a user actually wants, they have already asked
 * for once in chat and liked the answer to — so this door starts from that
 * turn, rewrites the one-off question as a standing instruction, and asks
 * the user ONE thing: when.
 *
 * Laws it inherits, and the one it is excused from:
 *
 *   U2 (nothing is armed untried) — EXCUSED, and this is the only door that
 *   may be. The preview already happened: it was the answer the user is
 *   looking at when they press the button. Forcing a second run here would
 *   charge a minute of model time to re-show what is on screen.
 *
 *   U10 (every door ends in one create_routine, and that call asks) — a
 *   user's click on a page IS the consent, the same standing rule
 *   `StarterPrompts.seed` and `ReviewRoutines` ride, so this arms without a
 *   second dialog. What it must never become is a door the MODEL can open:
 *   nothing here is reachable from a tool, only from a button the user
 *   presses on their own answer.
 *
 *   PrivateChat P3 (never learned from) — a private chat has no button.
 *   Arming a routine writes the conversation's words into a note that syncs;
 *   that is remembering, and the whole point of a private chat is that
 *   nothing does.
 */
const RoutineFromChat = {

    // Sensible standing time for a daily routine: early enough to be read
    // with coffee, late enough that the Mac is usually awake. The user
    // changes it in one click, which is the whole interaction.
    DEFAULT_TIME: '08:00',
    DEFAULT_INTERVAL: 'daily',

    INTERVALS: [['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Every week'], ['hourly', 'Every hour'], ['6h', 'Every 6 hours']],

    /**
     * @param {{question: string, answer: string}} turn — the exchange the
     *        user liked. `question` may be empty (the first turn of a
     *        conversation opened from a record); the answer carries enough.
     */
    async open(turn) {
        const question = String((turn && turn.question) || '').trim();
        const answer = String((turn && turn.answer) || '').trim();
        if (!answer) return;

        let state = { title: '', body: '', interval: this.DEFAULT_INTERVAL, time: this.DEFAULT_TIME };
        const modal = Modal.create({
            title: 'Repeat this',
            className: 'routine-from-chat-modal',
            content: `<p class="rfc-working" role="status" aria-live="polite"><span class="rfc-spinner" aria-hidden="true"></span>Turning this into something that runs on its own…</p>`
        });

        // The rewrite runs while the modal is already open: the click has to
        // feel instant, and a spinner the user can cancel is better than a
        // button that does nothing for four seconds.
        const res = await PromptFeed.standingInstruction({ question, answer });
        if (!modal.element.isConnected) return;   // closed while we thought

        if (res.error) {
            // Falling back to the question itself is better than failing:
            // the user's own words are a serviceable instruction, and they
            // can edit them in the box right there.
            state.body = question || answer.slice(0, 300);
            state.title = this._titleFrom(question || answer);
        } else {
            state.body = res.body;
            state.title = res.title || this._titleFrom(question || answer);
            // "What should I watch this week?" should not open on "Every
            // day". The suggestion is validated against the form's own
            // vocabulary upstream, and the user confirms it with one click.
            if (res.every) {
                state.interval = res.every;
                if (!['daily', 'weekdays', 'weekly'].includes(res.every)) state.time = '';
            }
        }

        this._render(modal, state);
    },

    _titleFrom(text) {
        const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');
        return words.replace(/[?.!,;:]+$/, '') || 'New routine';
    },

    _render(modal, state) {
        const esc = UIUtils.escapeHtml;
        modal.body.innerHTML = `
            <div class="rfc">
                <label class="rfc-label" for="rfc-title">Name</label>
                <input id="rfc-title" class="routines-trig-input rfc-title" type="text"
                       value="${esc(state.title)}" spellcheck="false" autocomplete="off">

                <label class="rfc-label" for="rfc-body">It will do this, every time</label>
                <textarea id="rfc-body" class="routines-body-input rfc-body" rows="4">${esc(state.body)}</textarea>

                <label class="rfc-label">When</label>
                <div class="prompt-mgr-seg rfc-when" role="group" aria-label="How often">
                    ${this.INTERVALS.map(([v, l]) => `
                        <button type="button" class="prompt-mgr-seg-btn ${state.interval === v ? 'active' : ''}"
                                data-interval="${v}" aria-pressed="${state.interval === v}">${l}</button>`).join('')}
                </div>
                <div class="rfc-time-row" ${['daily', 'weekdays', 'weekly'].includes(state.interval) ? '' : 'hidden'}>
                    <label class="rfc-label rfc-time-label" for="rfc-time">At</label>
                    <input type="time" id="rfc-time" class="routines-time" value="${esc(state.time)}">
                </div>

                <p class="rfc-hint">It runs on its own and posts the answer to your Home feed &mdash; and posts nothing on a run that finds nothing to say. It cannot change anything.</p>
            </div>`;

        const footer = document.createElement('div');
        footer.className = 'modal-footer rfc-footer';
        footer.innerHTML = `
            <button class="secondary-btn rfc-more" type="button">More options…</button>
            <span class="rfc-footer-gap"></span>
            <button class="secondary-btn rfc-cancel" type="button">Cancel</button>
            <button class="primary-btn rfc-arm" type="button">Arm it</button>`;
        modal.element.appendChild(footer);

        const q = (sel) => modal.element.querySelector(sel);
        const read = () => ({
            title: q('#rfc-title').value.trim(),
            body: q('#rfc-body').value.trim(),
            interval: state.interval,
            time: q('#rfc-time') ? q('#rfc-time').value : state.time
        });

        modal.element.querySelectorAll('[data-interval]').forEach(btn => {
            btn.addEventListener('click', () => {
                state.interval = btn.dataset.interval;
                modal.element.querySelectorAll('[data-interval]').forEach(x => {
                    x.classList.toggle('active', x === btn);
                    x.setAttribute('aria-pressed', String(x === btn));
                });
                q('.rfc-time-row').hidden = !['daily', 'weekdays', 'weekly'].includes(state.interval);
            });
        });

        q('.rfc-cancel').addEventListener('click', () => modal.close());

        // The escape hatch to everything this modal deliberately does not
        // ask about — email/file triggers, acting runs, web and context.
        // It hands the form the text and lets U2 apply there as usual.
        q('.rfc-more').addEventListener('click', () => {
            const v = read();
            modal.close();
            AppManager.openApp('prompts');
            PromptsApp.openWithDraft({ title: v.title, body: v.body, interval: v.interval, time: v.time });
        });

        q('.rfc-arm').addEventListener('click', () => {
            const v = read();
            if (!v.body) { q('#rfc-body').focus(); return; }
            const created = this.arm(v);
            modal.close();
            if (!created) { UIUtils.showToast('Could not create the routine', 'error'); return; }
            UIUtils.showToast(`“${created.title}” will run ${NotePrompts.scheduleLabel(NotePrompts.config(created))}`, 'success');
        });

        setTimeout(() => q('#rfc-body')?.focus(), 0);
    },

    /** The one write. Pure-ish: everything it needs is in `v`. */
    arm(v) {
        const timed = ['daily', 'weekdays', 'weekly'].includes(v.interval);
        const config = {
            ...NotePrompts.DEFAULTS,
            offline: true,
            runMode: 'digest',            // a routine born from a chat ANSWER writes an answer
            trigger: { type: 'time', interval: v.interval },
            interval: v.interval,
            time: timed ? (v.time || this.DEFAULT_TIME) : null,
            // It came from a chat that had the user's own data in front of
            // it; without this the standing version would answer from
            // nothing and be worse than the turn it was born from.
            useContext: true,
            web: false,
            homeMachineId: (typeof RoutineEngine !== 'undefined' && RoutineEngine._machineId) || null
        };
        const note = NotePrompts.create({ title: v.title || 'New routine', body: v.body, config });
        if (note && typeof RoutineEngine !== 'undefined') RoutineEngine.onRoutinesChanged();
        return note;
    }
};

if (typeof window !== 'undefined') window.RoutineFromChat = RoutineFromChat;
if (typeof module !== 'undefined' && module.exports) module.exports = RoutineFromChat;
