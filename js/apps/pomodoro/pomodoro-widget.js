/**
 * Pomodoro on home — the session, while there is one.
 *
 * An attention widget in the strict sense: it renders ONLY while a focus
 * session is live (running, or paused mid-way) and vanishes when the timer
 * is idle. Home never shows "0 pomodoros today" — the Pomodoro page has the
 * tally. The row is the task and the time left; the one action is
 * Pause/Resume, and the card head opens the timer.
 *
 * The time ticks in place (one element, once a second) rather than
 * re-rendering home every tick; `anjadhe:focus-changed` re-renders on
 * every real transition (start, pause, phase change, end).
 */
(function () {
    if (typeof Widgets === 'undefined') return;
    let tick = null;

    function live() {
        const P = PomodoroApp;
        return !!(P && P._initialized && (P.isRunning || P.remainingMs < P.durationMs));
    }

    Widgets.register('pomodoro', {
        title: 'Focus',
        app: 'pomodoro',
        order: 5, // above Today: it is what the user is doing right now
        load() {
            if (!live()) { if (tick) { clearInterval(tick); tick = null; } return null; }
            const P = PomodoroApp;
            const esc = UIUtils.escapeHtml.bind(UIUtils);
            const onBreak = P.mode !== 'focus';
            const task = onBreak ? (P.mode === 'long' ? 'Long break' : 'Short break') : ((P.currentTask || '').trim() || 'Focusing');
            const sub = onBreak ? (P.linkedTask()?.title ? `then back to ${P.linkedTask().title}` : 'step away from the screen')
                                : (P.linkedTask()?.project ? P.linkedTask().project : 'focus session');
            const state = P.isRunning ? '' : 'Paused';
            const body = `<ul class="widget-rows"><li class="widget-row">
                <span class="widget-row-when"><span data-pomo-time>${esc(P.formatTime(P.remainingMs))}</span></span>
                <span class="widget-row-text">${esc(task)}<span class="pomo-widget-sub"> · ${esc(sub)}</span></span>
                ${state ? `<span class="widget-row-flag">${state}</span>` : ''}
                <span class="widget-row-actions"><button class="widget-row-btn" type="button" data-w-action="toggle" data-w-id="">${P.isRunning ? 'Pause' : 'Resume'}</button></span>
            </li></ul>`;
            if (!tick) tick = setInterval(() => {
                const el = document.querySelector('[data-widget="pomodoro"] [data-pomo-time]');
                if (!el) return;
                el.textContent = PomodoroApp.formatTime(PomodoroApp.isRunning && PomodoroApp.endsAt ? Math.max(0, PomodoroApp.endsAt - Date.now()) : PomodoroApp.remainingMs);
            }, 1000);
            return { body, tone: onBreak ? 'good' : undefined, title: onBreak ? 'Break' : 'Focusing' };
        },
        onAction(action) {
            if (action === 'toggle') PomodoroApp.toggleStartPause();
        },
    });

    document.addEventListener('anjadhe:focus-changed', () => Widgets.refresh());
})();
