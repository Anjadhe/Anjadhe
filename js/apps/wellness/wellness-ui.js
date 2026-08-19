/**
 * Wellness UI — pure rendering for WellnessApp. All interactivity is
 * delegated through data-action attributes wired once in
 * WellnessApp.setupEventListeners(), so render() can rebuild freely.
 */

const WellnessUI = {

    render(app) {
        const body = document.getElementById('wellness-body');
        if (!body) return;

        if (!app.entries.length) {
            body.innerHTML = this.importBannerHtml(app) + this.emptyStateHtml(app);
            return;
        }

        const trends = app.trends();
        body.innerHTML =
            this.importBannerHtml(app) +
            this.todayStripHtml(app, trends) +
            this.quickLogHtml() +
            this.attentionHtml(trends) +
            this.tilesHtml(app) +
            this.chartCardHtml(app) +
            this.reviewsHtml(app) +
            this.historyHtml(app);

        this.renderChart(app);
    },

    // ── Today + attention (W1 — arithmetic only, see WellnessApp.trends) ──

    todayStripHtml(app, trends) {
        const esc = UIUtils.escapeHtml;
        if (!trends.today.length) {
            return `<p class="wellness-today is-empty">Nothing logged yet today.</p>`;
        }
        const bits = trends.today.map(t => `${t.count > 1 ? t.count + '× ' : ''}${esc(t.label)}`);
        return `<p class="wellness-today">Today: ${bits.join(' · ')}</p>`;
    },

    /**
     * The quick log is the page's primary door (W1): one line of plain
     * language, logged by the assistant with every detail kept. Replaces
     * the "Log by chatting" pill — same destination, but a composer says
     * "type here" where a quoted pill said "click to be taken elsewhere".
     */
    quickLogHtml() {
        if (typeof AgentUI === 'undefined' || typeof AgentService === 'undefined') return '';
        return `<div class="wellness-quicklog">
            <input type="text" id="wellness-quicklog" class="search-input"
                placeholder="Log anything… e.g. BP 128/82 after my walk · strength training 45 min, bench 3x8, squats 3x10"
                autocomplete="off">
            <button type="button" class="primary-btn" data-action="quicklog">Log</button>
        </div>`;
    },

    /** Renders NOTHING when there is nothing to say — quiet is the norm. */
    attentionHtml(trends) {
        const esc = UIUtils.escapeHtml;
        if (!trends.attention.length) return '';
        return `<div class="wellness-attention">
            ${trends.attention.map(a => `
                <p class="wellness-attention-item tone-${esc(a.tone)}">${esc(a.text)}</p>`).join('')}
        </div>`;
    },

    // ── Coach reviews (W3 — armed routines, the ReviewRoutines pattern) ──

    reviewsHtml(app) {
        if (typeof NotePrompts === 'undefined') return '';
        const esc = UIUtils.escapeHtml;
        const armed = (title) => NotePrompts.list().some(n =>
            (n.title || '').trim().toLowerCase() === title.toLowerCase() && NotePrompts.config(n).offline);
        const voices = (typeof VoiceStore !== 'undefined')
            ? VoiceStore.pages().filter(v => (v.body || '').trim()) : [];
        const voiceSelect = (id) => voices.length
            ? `<select class="wellness-review-voice" id="${id}" title="Write it in one of your Writing Voices">
                <option value="">Assistant's own voice</option>
                ${voices.map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}
               </select>`
            : '';
        const row = (title, blurb, action, voiceSelId) => `
            <div class="wellness-review-row">
                <div class="wellness-review-text">
                    <div class="wellness-review-title">${esc(title)}</div>
                    <p class="wellness-review-blurb">${esc(blurb)}</p>
                </div>
                <span class="wellness-review-actions">
                    ${armed(title)
                        ? `<button type="button" class="secondary-btn" data-action="open-routines">Armed &#10003; &middot; Routines</button>`
                        : `${voiceSelect(voiceSelId)}<button type="button" class="secondary-btn" data-action="${action}">Turn on</button>`}
                </span>
            </div>`;
        return `<div class="wellness-card wellness-reviews">
            <div class="wellness-reviews-head">AI reviews</div>
            ${row('Wellness Review',
                'Every Sunday morning: an honest read of your week — what you kept up, real trends from the computed numbers, and one suggestion. Posts to your Home feed.',
                'arm-weekly-review', 'wellness-voice-weekly')}
            ${row('Daily Wellness Check-in',
                'A short morning note: yesterday\'s numbers, your streaks, one intention for today.',
                'arm-daily-checkin', 'wellness-voice-daily')}
        </div>`;
    },

    // ── Conversation door ──────────────────────────────────────────────

    /**
     * "Log by chatting" — the pill for anyone who would rather say
     * "BP 128 over 82 after my walk" than pick a kind and fill a form.
     * Quoted like every other ask-pill in the app (see .ask-prompt-btn in
     * components.css); the assistant's log_wellness tool does the writing,
     * so nothing here bypasses the normal permission path.
     */
    askRowHtml(opts = {}) {
        if (typeof AgentUI === 'undefined' || !AgentUI.askWithPrompt) return '';
        const prompt = 'I want to log health data in my Wellness tracker by chatting. '
            + 'Ask me what I want to record, then save each entry with log_wellness and tell me what you logged. '
            + 'If I mention several things at once, log them all, putting meals and activities in before any '
            + 'reading that followed them so the reading keeps its timing context.';
        return `<div class="ask-prompt-row wellness-ask-row">
            <button type="button" class="ask-prompt-btn${opts.primary ? ' primary' : ''}"
                data-action="ask" data-ask="${UIUtils.escapeHtml(prompt)}">&ldquo;Log by chatting&rdquo;</button>
        </div>`;
    },

    // ── Empty state / legacy import ────────────────────────────────────

    emptyStateHtml(app) {
        const esc = UIUtils.escapeHtml;
        const cats = app.CATEGORIES.map(cat => {
            const kinds = Object.keys(app.KINDS).filter(k => app.KINDS[k].cat === cat.id);
            return `<div class="wellness-empty-cat">
                <div class="wellness-empty-cat-label">${esc(cat.label)}</div>
                <div class="wellness-empty-kinds">${kinds.map(k =>
                    `<button type="button" class="wellness-empty-kind" data-action="log" data-kind="${k}">
                        <span class="wellness-mono">${app.KINDS[k].mono}</span>${esc(app.KINDS[k].label)}
                    </button>`).join('')}
                </div>
            </div>`;
        }).join('');
        return `<div class="wellness-empty">
            <h3 class="wellness-empty-title">Track everything that matters to your health</h3>
            <p class="wellness-empty-sub">Blood pressure, weight, glucose, sleep, meals, water, workouts, mood: logged in seconds, charted over time, and readable by your AI assistant. Start with whatever you measure today.</p>
            ${this.askRowHtml({ primary: true })}
            ${cats}
        </div>`;
    },

    importBannerHtml(app) {
        if (!app.shouldOfferImport()) return '';
        const legacy = app.legacyData();
        return `<div class="wellness-import-banner">
            <div class="wellness-import-text">
                <strong>Bring your data over.</strong>
                Your custom Wellness Data Tracker app has ${legacy.count} entries (readings, meals, activities, sleep). Import them here. The original app is left untouched.
            </div>
            <div class="wellness-import-actions">
                <button type="button" class="secondary-btn" data-action="dismiss-import">Not now</button>
                <button type="button" class="primary-btn" data-action="import-legacy">Import ${legacy.count} entries</button>
            </div>
        </div>`;
    },

    // ── Summary tiles ──────────────────────────────────────────────────

    tilesHtml(app) {
        const esc = UIUtils.escapeHtml;
        const s = app.summary();
        const tiles = [];

        if (s.latestBp) {
            const cat = app.categorizeBp(Number(s.latestBp.systolic), Number(s.latestBp.diastolic));
            tiles.push(this._tile(
                `${esc(String(s.latestBp.systolic))}/${esc(String(s.latestBp.diastolic))}`,
                'Latest BP',
                `<span class="${cat.cls}">${cat.label}</span>${s.latestBp.pulse ? ' &middot; ' + esc(String(s.latestBp.pulse)) + ' bpm' : ''}`
            ));
        }
        if (s.bpLast7Days) {
            tiles.push(this._tile(
                `${s.bpLast7Days.systolic}/${s.bpLast7Days.diastolic}`,
                '7-day BP average',
                `${s.bpLast7Days.count} reading${s.bpLast7Days.count === 1 ? '' : 's'}`
            ));
        }
        if (s.latestWeight) {
            const d = s.latestWeight.delta;
            tiles.push(this._tile(
                `${s.latestWeight.value}<span class="wellness-tile-unit"> ${esc(s.latestWeight.unit)}</span>`,
                'Weight',
                d == null ? '&nbsp;' : (d === 0 ? 'no change' : `${d > 0 ? '+' : ''}${d} ${esc(s.latestWeight.unit)} vs last`)
            ));
        }
        if (s.latestGlucose) {
            tiles.push(this._tile(
                `${s.latestGlucose.value}<span class="wellness-tile-unit"> ${esc(s.latestGlucose.unit)}</span>`,
                'Glucose',
                s.latestGlucose.context ? esc(s.latestGlucose.context) : '&nbsp;'
            ));
        }
        if (s.lastSleep) {
            tiles.push(this._tile(
                `${s.lastSleep.hours}<span class="wellness-tile-unit"> h</span>`,
                'Sleep',
                esc(app.fmtDate(s.lastSleep.date).replace(/, \d{4}$/, ''))
            ));
        }
        // Water is always shown once anything is logged — the quick-add button
        // is the cheapest logging gesture in the app.
        const water = app.waterTodayTotal();
        tiles.push(this._tile(
            `${water.total}<span class="wellness-tile-unit"> ${esc(water.unit)}</span>`,
            'Water today',
            `<button type="button" class="wellness-quick-water" data-action="quick-water">+ ${water.unit === 'ml' ? '250 ml' : '8 oz'}</button>`
        ));

        return `<div class="wellness-tiles">${tiles.join('')}</div>`;
    },

    _tile(value, label, meta) {
        return `<div class="wellness-tile">
            <div class="wellness-tile-value">${value}</div>
            <div class="wellness-tile-label">${label}</div>
            <div class="wellness-tile-meta">${meta}</div>
        </div>`;
    },

    // ── Trend chart ────────────────────────────────────────────────────

    chartCardHtml(app) {
        const esc = UIUtils.escapeHtml;
        // Offer only metrics with at least 2 points to draw, judged over all
        // time (a metric shouldn't vanish from the picker on a narrow range).
        const metrics = app.CHART_METRICS.filter(m => {
            const savedMetric = app.chartMetric, savedRange = app.chartRange;
            app.chartMetric = m.id; app.chartRange = 0;
            const data = app.chartData();
            app.chartMetric = savedMetric; app.chartRange = savedRange;
            return data.series.some(sr => sr.points.length >= 2);
        });
        if (!metrics.length) return '';
        if (!metrics.some(m => m.id === app.chartMetric)) app.chartMetric = metrics[0].id;

        const metricChips = metrics.map(m =>
            `<button type="button" class="wellness-chip ${m.id === app.chartMetric ? 'active' : ''}" data-action="chart-metric" data-metric="${m.id}">${esc(m.label)}</button>`
        ).join('');
        const ranges = [[14, '2W'], [30, '1M'], [90, '3M'], [0, 'All']];
        const rangeChips = ranges.map(([d, label]) =>
            `<button type="button" class="wellness-chip wellness-chip-sm ${d === app.chartRange ? 'active' : ''}" data-action="chart-range" data-range="${d}">${label}</button>`
        ).join('');

        return `<div class="wellness-card wellness-chart-card">
            <div class="wellness-chart-toolbar">
                <div class="wellness-chip-row">${metricChips}</div>
                <div class="wellness-chip-row">${rangeChips}</div>
            </div>
            <div id="wellness-chart" class="wellness-chart-container"></div>
        </div>`;
    },

    renderChart(app) {
        const container = document.getElementById('wellness-chart');
        if (!container) return;
        const data = app.chartData();
        const series = data.series.filter(sr => sr.points.length >= 2);
        if (!series.length) {
            container.innerHTML = '<p class="wellness-chart-empty">Not enough data in this range. Log a couple more entries or widen the range.</p>';
            return;
        }

        const width = container.clientWidth || 640;
        const height = 220;
        const pad = { top: 14, right: 16, bottom: 26, left: 44 };
        const chartW = width - pad.left - pad.right;
        const chartH = height - pad.top - pad.bottom;

        const allPts = series.flatMap(sr => sr.points);
        const ts = allPts.map(p => p.t);
        const vs = allPts.map(p => p.v).concat((data.refLines || []).map(r => r.v));
        const tMin = Math.min(...ts), tMax = Math.max(...ts);
        let vMin = Math.min(...vs), vMax = Math.max(...vs);
        const vPad = (vMax - vMin || Math.abs(vMax) || 1) * 0.12;
        vMin -= vPad; vMax += vPad;

        const toX = (t) => pad.left + (tMax === tMin ? chartW / 2 : ((t - tMin) / (tMax - tMin)) * chartW);
        const toY = (v) => pad.top + chartH - ((v - vMin) / (vMax - vMin)) * chartH;

        // Grid + y labels (4 ticks)
        let gridHtml = '';
        for (let i = 0; i <= 4; i++) {
            const v = vMin + ((vMax - vMin) * i) / 4;
            const y = toY(v);
            const label = Math.abs(v) >= 10000 ? `${Math.round(v / 1000)}k`
                : (vMax - vMin) > 5 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
            gridHtml += `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" class="wellness-gridline"/>`;
            gridHtml += `<text x="${pad.left - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" class="wellness-chart-label">${label}</text>`;
        }

        // X labels — up to 5 date ticks across the time span
        let xHtml = '';
        const tickCount = Math.min(5, allPts.length);
        for (let i = 0; i < tickCount; i++) {
            const t = tMin + ((tMax - tMin) * i) / Math.max(1, tickCount - 1);
            const d = new Date(t);
            xHtml += `<text x="${toX(t).toFixed(1)}" y="${height - 6}" text-anchor="middle" class="wellness-chart-label">${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</text>`;
        }

        // Reference lines (e.g. 120/80 for BP) — subtle, labeled at the right edge
        let refHtml = '';
        for (const r of data.refLines || []) {
            if (r.v <= vMin || r.v >= vMax) continue;
            const y = toY(r.v);
            refHtml += `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" class="wellness-refline"/>`;
        }

        // Series lines + point markers
        let seriesHtml = '';
        for (const sr of series) {
            const pts = sr.points.slice().sort((a, b) => a.t - b.t);
            const path = pts.map((p, i) => `${i ? 'L' : 'M'} ${toX(p.t).toFixed(1)} ${toY(p.v).toFixed(1)}`).join(' ');
            seriesHtml += `<path d="${path}" class="wellness-line wellness-line-${sr.cls}"/>`;
            seriesHtml += pts.map(p =>
                `<circle cx="${toX(p.t).toFixed(1)}" cy="${toY(p.v).toFixed(1)}" r="2.5" class="wellness-dot wellness-dot-${sr.cls}"/>`
            ).join('');
        }

        const legend = series.length > 1
            ? `<div class="wellness-chart-legend">${series.map(sr =>
                `<span class="wellness-legend-item"><span class="wellness-legend-swatch wellness-legend-${sr.cls}"></span>${UIUtils.escapeHtml(sr.name)}</span>`).join('')}
               <span class="wellness-chart-unit">${UIUtils.escapeHtml(data.unit || '')}</span></div>`
            : `<div class="wellness-chart-legend"><span class="wellness-chart-unit">${UIUtils.escapeHtml(data.unit || '')}</span></div>`;

        container.innerHTML = `
            <svg width="${width}" height="${height}" class="wellness-chart-svg" role="img" aria-label="${UIUtils.escapeHtml(series.map(s => s.name).join(' and '))} trend">
                ${gridHtml}${refHtml}${xHtml}${seriesHtml}
                <line class="wellness-crosshair" y1="${pad.top}" y2="${pad.top + chartH}" style="display:none"/>
            </svg>
            <div class="wellness-chart-tooltip" style="display:none"></div>
            ${legend}`;

        // Hover: nearest time across all series → crosshair + tooltip
        const svg = container.querySelector('svg');
        const tooltip = container.querySelector('.wellness-chart-tooltip');
        const crosshair = container.querySelector('.wellness-crosshair');
        const times = Array.from(new Set(allPts.map(p => p.t))).sort((a, b) => a - b);

        svg.addEventListener('mousemove', (e) => {
            const rect = svg.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            let nearest = times[0], best = Infinity;
            for (const t of times) {
                const d = Math.abs(toX(t) - mx);
                if (d < best) { best = d; nearest = t; }
            }
            const x = toX(nearest);
            crosshair.style.display = '';
            crosshair.setAttribute('x1', x.toFixed(1));
            crosshair.setAttribute('x2', x.toFixed(1));

            const rows = [];
            let timeLabel = '';
            for (const sr of series) {
                const p = sr.points.find(pp => pp.t === nearest);
                if (p) {
                    rows.push(`<div class="wellness-tt-row"><span class="wellness-legend-swatch wellness-legend-${sr.cls}"></span>${UIUtils.escapeHtml(sr.name)}: <strong>${p.v}</strong></div>`);
                    timeLabel = p.timeLabel;
                }
            }
            tooltip.innerHTML = `<div class="wellness-tt-time">${UIUtils.escapeHtml(timeLabel)}</div>${rows.join('')}`;
            tooltip.style.display = '';
            const ttW = tooltip.offsetWidth || 120;
            tooltip.style.left = Math.min(Math.max(0, x - ttW / 2), width - ttW) + 'px';
        });
        svg.addEventListener('mouseleave', () => {
            tooltip.style.display = 'none';
            crosshair.style.display = 'none';
        });
    },

    // ── History timeline ───────────────────────────────────────────────

    historyHtml(app) {
        const esc = UIUtils.escapeHtml;
        const filter = app.historyFilter;
        const entries = app.sorted().filter(e => filter === 'all' || e.kind === filter);

        const filterOptions = ['<option value="all">Everything</option>'].concat(
            app.CATEGORIES.map(cat => {
                const opts = Object.keys(app.KINDS)
                    .filter(k => app.KINDS[k].cat === cat.id && app.entries.some(e => e.kind === k))
                    .map(k => `<option value="${k}" ${filter === k ? 'selected' : ''}>${esc(app.KINDS[k].label)}</option>`);
                return opts.length ? `<optgroup label="${esc(cat.label)}">${opts.join('')}</optgroup>` : '';
            })
        ).join('');

        const dates = Array.from(new Set(entries.map(e => e.time.slice(0, 10)))).sort().reverse();
        const daysHtml = dates.map(dateKey => this.dayCardHtml(app, dateKey, entries)).join('');

        return `<div class="wellness-history">
            <div class="wellness-history-head">
                <h3 class="wellness-section-title">History</h3>
                <select id="wellness-history-filter" class="sort-select">${filterOptions}</select>
            </div>
            ${daysHtml || '<p class="wellness-chart-empty">Nothing logged for this filter yet.</p>'}
        </div>`;
    },

    dayCardHtml(app, dateKey, entries) {
        const esc = UIUtils.escapeHtml;
        const day = entries.filter(e => e.time.slice(0, 10) === dateKey)
            .sort((a, b) => a.time.localeCompare(b.time));

        // Day summary chips (always computed over ALL entries for the day,
        // not the filtered list — the day's context shouldn't vanish when
        // the user filters to one metric).
        const chips = [];
        const dayAll = app.forDay(dateKey);
        const bpAvg = app.avgBp(dayAll);
        if (bpAvg) chips.push(`avg BP ${bpAvg.systolic}/${bpAvg.diastolic}`);
        const sleep = dayAll.filter(e => e.kind === 'sleep').pop();
        if (sleep) chips.push(`slept ${esc(String(sleep.hours))} h`);
        const waterUnit = app.unitFor('water');
        const water = dayAll.filter(e => e.kind === 'water')
            .reduce((t, e) => t + app.convert(Number(e.amount) || 0, e.unit || waterUnit, waterUnit), 0);
        if (water) chips.push(`${Math.round(water)} ${waterUnit} water`);
        const actMin = dayAll.filter(e => e.kind === 'activity').reduce((t, e) => t + (Number(e.duration) || 0), 0);
        if (actMin) chips.push(`${actMin} min active`);
        const steps = dayAll.filter(e => e.kind === 'steps').pop();
        if (steps) chips.push(`${esc(String(steps.value))} steps`);
        const moods = dayAll.filter(e => e.kind === 'mood');
        if (moods.length) {
            const spec = app.KINDS.mood.fields.find(f => f.id === 'mood');
            const avg = Math.round(moods.reduce((t, e) => t + Number(e.mood || 0), 0) / moods.length);
            if (spec.scale[avg - 1]) chips.push(`mood: ${spec.scale[avg - 1].toLowerCase()}`);
        }

        const rows = day.map(e => this.entryRowHtml(app, e)).join('');

        return `<div class="wellness-card wellness-day">
            <div class="wellness-day-head">
                <h4 class="wellness-day-title">${esc(app.fmtDate(dateKey))}</h4>
                <div class="wellness-day-chips">${chips.map(c => `<span class="wellness-day-chip">${c}</span>`).join('')}</div>
            </div>
            <div class="wellness-day-rows">${rows}</div>
        </div>`;
    },

    entryRowHtml(app, e) {
        const esc = UIUtils.escapeHtml;
        const spec = app.KINDS[e.kind];
        const f = this.formatEntry(app, e);
        return `<div class="wellness-row">
            <span class="wellness-row-time">${e.kind === 'sleep' ? 'night' : esc(app.fmtTime(e.time))}</span>
            <span class="wellness-mono" title="${esc(spec.label)}">${spec.mono}</span>
            <span class="wellness-row-main">
                <span class="wellness-row-primary">${f.primary}</span>
                ${f.meta ? `<span class="wellness-row-meta">${f.meta}</span>` : ''}
            </span>
            <span class="wellness-row-actions">
                <button type="button" class="wellness-row-btn" data-action="edit" data-id="${esc(e.id)}">Edit</button>
                <button type="button" class="wellness-row-btn" data-action="delete" data-id="${esc(e.id)}">Delete</button>
            </span>
        </div>`;
    },

    // Compact one-line rendering per kind: {primary, meta}. Meta carries the
    // context correlation for BP/glucose ("1 h 10 min after lunch").
    formatEntry(app, e) {
        const esc = UIUtils.escapeHtml;
        const notes = e.notes ? esc(e.notes) : '';
        const scaleWord = (kindId, fieldId, v) => {
            const spec = app.KINDS[kindId].fields.find(f => f.id === fieldId);
            return spec && spec.scale && spec.scale[v - 1] ? spec.scale[v - 1] : null;
        };
        const ctxMeta = () => {
            const ctx = app.contextBefore(e.time);
            const bits = [];
            if (ctx.lastMeal) bits.push(app.gapText(ctx.lastMeal.time, e.time) + ' ' + esc((ctx.lastMeal.mealType || 'meal').toLowerCase()) + (ctx.lastMeal.description ? ' (' + esc(ctx.lastMeal.description) + ')' : ''));
            if (ctx.lastActivity) bits.push(app.gapText(ctx.lastActivity.time, e.time) + ' ' + app.activityLabel(ctx.lastActivity, true));
            return bits.join(' &middot; ');
        };
        const joinMeta = (...parts) => parts.filter(Boolean).join(' &middot; ');

        switch (e.kind) {
            case 'bp': {
                const cat = app.categorizeBp(Number(e.systolic), Number(e.diastolic));
                return {
                    primary: `${esc(String(e.systolic))}/${esc(String(e.diastolic))}`,
                    meta: joinMeta(e.pulse ? esc(String(e.pulse)) + ' bpm' : '', `<span class="${cat.cls}">${cat.label}</span>`, ctxMeta(), notes)
                };
            }
            case 'pulse':
                return { primary: `${esc(String(e.value))} bpm resting`, meta: notes };
            case 'glucose': {
                const d = app.displayValue(e, 'value', 'glucose');
                return { primary: `${d.value} ${esc(d.unit)}`, meta: joinMeta(e.context ? esc(e.context) : '', ctxMeta(), notes) };
            }
            case 'spo2':
                return { primary: `SpO2 ${esc(String(e.value))}%`, meta: notes };
            case 'temperature': {
                const d = app.displayValue(e, 'value', 'temperature');
                return { primary: `${d.value}&deg;${esc(d.unit)}`, meta: notes };
            }
            case 'weight': {
                const d = app.displayValue(e, 'value', 'weight');
                return { primary: `${d.value} ${esc(d.unit)}`, meta: notes };
            }
            case 'activity':
                return { primary: app.activityLabel(e), meta: notes };
            case 'steps':
                return { primary: `${esc(String(e.value))} steps`, meta: notes };
            case 'meal':
                return { primary: esc(e.mealType || 'Meal'), meta: joinMeta(e.description ? esc(e.description) : '', notes) };
            case 'water': {
                const d = app.displayValue(e, 'amount', 'water');
                return { primary: `${d.value} ${esc(d.unit)} water`, meta: '' };
            }
            case 'sleep': {
                const q = e.quality ? scaleWord('sleep', 'quality', Number(e.quality)) : null;
                return { primary: `${esc(String(e.hours))} h sleep`, meta: joinMeta(q ? esc(q.toLowerCase()) : '', notes) };
            }
            case 'mood': {
                const parts = [];
                const m = scaleWord('mood', 'mood', Number(e.mood));
                if (m) parts.push('Mood: ' + m.toLowerCase());
                const en = e.energy ? scaleWord('mood', 'energy', Number(e.energy)) : null;
                if (en) parts.push('energy ' + en.toLowerCase());
                const st = e.stress ? scaleWord('mood', 'stress', Number(e.stress)) : null;
                if (st) parts.push('stress ' + st.toLowerCase());
                return { primary: esc(parts.shift() || 'Mood'), meta: joinMeta(parts.map(esc).join(', '), notes) };
            }
            case 'medication':
                return { primary: esc(e.name || 'Medication'), meta: joinMeta(e.dose ? esc(e.dose) : '', notes) };
            case 'symptom': {
                const sev = e.severity ? scaleWord('symptom', 'severity', Number(e.severity)) : null;
                return { primary: esc(e.name || 'Symptom'), meta: joinMeta(sev ? esc(sev.toLowerCase()) : '', notes) };
            }
            case 'note':
                return { primary: notes, meta: '' };
            default:
                return { primary: esc(spec ? spec.label : e.kind), meta: notes };
        }
    },

    // ── Log menu ───────────────────────────────────────────────────────

    logMenuHtml(app) {
        const esc = UIUtils.escapeHtml;
        return app.CATEGORIES.map(cat => {
            const kinds = Object.keys(app.KINDS).filter(k => app.KINDS[k].cat === cat.id);
            return `<p class="wellness-menu-group">${esc(cat.label)}</p>` + kinds.map(k =>
                `<button type="button" class="wellness-menu-item" data-kind="${k}">
                    <span class="wellness-mono">${app.KINDS[k].mono}</span>${esc(app.KINDS[k].label)}
                </button>`).join('');
        }).join('');
    },

    // ── Modal forms ────────────────────────────────────────────────────

    formHtml(app, kind, existing) {
        const esc = UIUtils.escapeHtml;
        const spec = app.KINDS[kind];
        const now = app.nowLocal();

        let timeHtml;
        if (spec.dateOnly) {
            const val = existing ? existing.time.slice(0, 10) : now.slice(0, 10);
            timeHtml = `<label class="wellness-field"><span class="wellness-field-label">Morning of</span>
                <input type="date" data-field="__time" value="${val}" required></label>`;
        } else {
            const val = existing ? existing.time.slice(0, 16) : now;
            timeHtml = `<label class="wellness-field"><span class="wellness-field-label">When</span>
                <input type="datetime-local" data-field="__time" value="${val}" required></label>`;
        }

        const hintHtml = spec.hint ? `<p id="wellness-form-hint" class="wellness-form-hint">${this.contextHintHtml(app, existing ? existing.time : now)}</p>` : '';

        let fieldsHtml = '';
        let pendingHalf = null;
        for (const f of spec.fields) {
            const fieldHtml = this._fieldHtml(app, f, existing);
            if (f.half) {
                if (pendingHalf) {
                    fieldsHtml += `<div class="wellness-field-pair">${pendingHalf}${fieldHtml}</div>`;
                    pendingHalf = null;
                } else {
                    pendingHalf = fieldHtml;
                }
            } else {
                if (pendingHalf) { fieldsHtml += `<div class="wellness-field-pair">${pendingHalf}</div>`; pendingHalf = null; }
                fieldsHtml += fieldHtml;
            }
        }
        if (pendingHalf) fieldsHtml += `<div class="wellness-field-pair">${pendingHalf}</div>`;

        return `<div class="wellness-form" data-kind="${esc(kind)}">${timeHtml}${hintHtml}${fieldsHtml}</div>`;
    },

    _fieldHtml(app, f, existing) {
        const esc = UIUtils.escapeHtml;
        const raw = existing && existing[f.id] != null ? existing[f.id] : '';
        let label = f.label;
        if (f.unitKey) label += ` (${app.unitFor(f.unitKey)})`;

        if (f.type === 'select') {
            const opts = f.options.map(o => `<option ${String(raw) === o ? 'selected' : ''}>${esc(o)}</option>`).join('');
            return `<label class="wellness-field"><span class="wellness-field-label">${esc(label)}</span>
                <select data-field="${f.id}">${opts}</select></label>`;
        }
        if (f.type === 'segment') {
            const btns = f.scale.map((word, i) =>
                `<button type="button" class="wellness-seg-btn ${Number(raw) === i + 1 ? 'active' : ''}" data-value="${i + 1}" title="${esc(word)}">${i + 1}<span class="wellness-seg-word">${esc(word)}</span></button>`
            ).join('');
            return `<div class="wellness-field"><span class="wellness-field-label">${esc(label)}</span>
                <div class="wellness-segment" data-field="${f.id}">${btns}</div></div>`;
        }
        if (f.type === 'number') {
            const attrs = [
                f.min != null ? `min="${f.min}"` : '',
                f.max != null ? `max="${f.max}"` : '',
                f.step != null ? `step="${f.step}"` : '',
                f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''
            ].join(' ');
            return `<label class="wellness-field"><span class="wellness-field-label">${esc(label)}</span>
                <input type="number" data-field="${f.id}" value="${raw !== '' ? esc(String(raw)) : ''}" ${attrs}></label>`;
        }
        if (f.type === 'textarea') {
            // Notes hold real content (the exercises in a workout, how a
            // symptom developed) — a one-line field said "a word or two".
            return `<label class="wellness-field wellness-field-notes"><span class="wellness-field-label">${esc(label)}</span>
                <textarea data-field="${f.id}" rows="3" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>${esc(String(raw))}</textarea></label>`;
        }
        return `<label class="wellness-field"><span class="wellness-field-label">${esc(label)}</span>
            <input type="text" data-field="${f.id}" value="${esc(String(raw))}" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}></label>`;
    },

    // Live context hint under the time field for BP/glucose: what the reading
    // will land after, so timing context is visible before saving.
    contextHintHtml(app, timeValue) {
        const esc = UIUtils.escapeHtml;
        if (!timeValue) return '';
        const ctx = app.contextBefore(timeValue);
        const lines = [];
        lines.push(ctx.lastMeal
            ? `This will be <strong>${app.gapText(ctx.lastMeal.time, timeValue)} ${esc((ctx.lastMeal.mealType || 'meal').toLowerCase())}</strong>${ctx.lastMeal.description ? ' (' + esc(ctx.lastMeal.description) + ')' : ''}.`
            : '<span class="wellness-hint-empty">No meals logged earlier this day: a fasting reading, or log the meal first.</span>');
        if (ctx.lastActivity) {
            lines.push(`And <strong>${app.gapText(ctx.lastActivity.time, timeValue)}</strong> ${app.activityLabel(ctx.lastActivity, true)}.`);
        }
        return lines.join('<br>');
    },

    wireForm(app, root, kind) {
        // Segment pickers: single-select toggle
        root.querySelectorAll('.wellness-segment').forEach(seg => {
            seg.addEventListener('click', (e) => {
                const btn = e.target.closest('.wellness-seg-btn');
                if (!btn) return;
                const wasActive = btn.classList.contains('active');
                seg.querySelectorAll('.wellness-seg-btn').forEach(b => b.classList.remove('active'));
                if (!wasActive) btn.classList.add('active');
            });
        });
        // Live meal/activity hint follows the time field
        const spec = app.KINDS[kind];
        if (spec.hint) {
            const timeInput = root.querySelector('[data-field="__time"]');
            timeInput.addEventListener('input', () => {
                const hint = root.querySelector('#wellness-form-hint');
                if (hint) hint.innerHTML = this.contextHintHtml(app, timeInput.value);
            });
        }
        // Focus the first data field for fast keyboard entry
        const first = root.querySelector('input[type="number"], input[type="text"], select');
        if (first) setTimeout(() => first.focus(), 50);
    },

    unitsHtml(app) {
        const esc = UIUtils.escapeHtml;
        const labels = { weight: 'Weight', glucose: 'Blood glucose', temperature: 'Temperature', water: 'Water' };
        return '<div class="wellness-form">' + Object.keys(app.UNIT_OPTIONS).map(key =>
            `<label class="wellness-field"><span class="wellness-field-label">${esc(labels[key])}</span>
                <select data-unit-key="${key}">${app.UNIT_OPTIONS[key].map(u =>
                    `<option ${app.unitFor(key) === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></label>`
        ).join('') + '<p class="wellness-form-hint">Existing entries keep the unit they were logged in and convert for display.</p></div>';
    }
};
