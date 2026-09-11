/**
 * Celebration — a small confetti burst for moments worth marking (task
 * completion). Fired from ScheduleApp.toggleComplete, the one funnel every
 * user-driven completion path goes through.
 *
 * Particles are animated with the Web Animations API, not CSS @keyframes:
 * the app's animation rule (motion may move content, never reveal it) exists
 * because CSS animation clocks stall in hidden windows — a burst only ever
 * fires from a click, but element.animate() with explicit cleanup can't
 * strand anything on screen regardless.
 *
 * The palette is a deliberate exception to the monochrome theme (by request,
 * 2026-08-05): a celebration should read as a party, and the effect is
 * transient — it never sits in the chrome.
 */

const Celebration = {
    // Last pointerdown, so burst() can fire where the user actually clicked
    // without every caller having to thread coordinates through.
    _pointer: { x: 0, y: 0, t: 0 },

    _POINTER_FRESH_MS: 2000,
    _COUNT: 28,

    // Classic confetti colors, saturated enough to carry in both themes.
    _COLORS: ['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'],

    init() {
        document.addEventListener('pointerdown', (e) => {
            this._pointer = { x: e.clientX, y: e.clientY, t: Date.now() };
        }, true);
    },

    burst() {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

        const fresh = Date.now() - this._pointer.t < this._POINTER_FRESH_MS;
        const ox = fresh ? this._pointer.x : window.innerWidth / 2;
        const oy = fresh ? this._pointer.y : window.innerHeight / 2;

        const layer = document.createElement('div');
        layer.className = 'celebration-layer';

        const animations = [];
        for (let i = 0; i < this._COUNT; i++) {
            const bit = document.createElement('span');
            const dot = i % 3 === 0;
            bit.className = `celebration-bit${dot ? ' celebration-bit--dot' : ''}`;
            bit.style.background = this._COLORS[i % this._COLORS.length];
            if (dot) {
                const d = 5 + Math.random() * 4;
                bit.style.width = `${d}px`;
                bit.style.height = `${d}px`;
            } else {
                bit.style.width = `${4 + Math.random() * 3}px`;
                bit.style.height = `${8 + Math.random() * 6}px`;
            }
            bit.style.left = `${ox}px`;
            bit.style.top = `${oy}px`;
            layer.appendChild(bit);

            // Upward fan with gravity: sample the ballistic arc at four
            // keyframes so WAAPI's interpolation reads as a real toss.
            const angle = (-90 + (Math.random() - 0.5) * 170) * Math.PI / 180;
            const speed = 90 + Math.random() * 130;
            const vx = Math.cos(angle) * speed;
            const vy = Math.sin(angle) * speed;
            const gravity = 320;
            const duration = 800 + Math.random() * 400;
            const spin = (Math.random() - 0.5) * 1080;

            const frames = [0, 1 / 3, 2 / 3, 1].map(p => {
                const t = p * (duration / 1000);
                return {
                    transform: `translate(${vx * t}px, ${vy * t + 0.5 * gravity * t * t}px) rotate(${spin * p}deg)`,
                    opacity: p < 2 / 3 ? 1 : 1 - (p - 2 / 3) * 3,
                    offset: p
                };
            });
            animations.push(bit.animate(frames, { duration, easing: 'linear', fill: 'forwards' }));
        }

        document.body.appendChild(layer);

        const cleanup = () => layer.remove();
        Promise.all(animations.map(a => a.finished.catch(() => {}))).then(cleanup);
        setTimeout(cleanup, 2000);
    }
};

Celebration.init();
