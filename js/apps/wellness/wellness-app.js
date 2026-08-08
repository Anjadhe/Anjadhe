/**
 * Wellness App — one place to log health data: vitals (blood pressure, pulse,
 * glucose, SpO2, temperature), body (weight), lifestyle (meals, water,
 * activity, steps, sleep), and mind (mood, medications, symptoms, notes).
 *
 * Everything is a single `entries` array; each entry has {id, kind, time,
 * ...kind fields}. The KINDS registry below drives the log menu, the modal
 * forms, the timeline rendering, the charts, and the assistant tools — add a
 * new metric by adding one registry entry.
 *
 * Deliberately NOT profile-aware: vitals belong to the person, not to a
 * Work/Personal lens — filtering half your BP history by active profile
 * would be misleading in a health app.
 */

const WellnessApp = {
    entries: [],
    settings: { units: { weight: 'lb', glucose: 'mg/dL', temperature: 'F', water: 'oz' } },
    chartMetric: 'bp',
    chartRange: 30,          // days; 0 = all time
    historyFilter: 'all',    // 'all' | kind id
    _importDismissed: false,
    _wired: false,

    UNIT_OPTIONS: {
        weight: ['lb', 'kg'],
        glucose: ['mg/dL', 'mmol/L'],
        temperature: ['F', 'C'],
        water: ['oz', 'ml']
    },

    // Registry of everything the app can track. `cat` groups the log menu and
    // history filter; `mono` is the two-letter chip shown in the timeline
    // (monochrome, no emoji — house style). `unitKey` marks fields whose unit
    // follows Settings › Units and is stamped onto the entry at log time.
    KINDS: {
        bp: {
            label: 'Blood pressure', cat: 'vitals', mono: 'BP', hint: true,
            fields: [
                { id: 'systolic', label: 'Systolic', type: 'number', min: 50, max: 260, placeholder: '120', required: true, half: true },
                { id: 'diastolic', label: 'Diastolic', type: 'number', min: 30, max: 160, placeholder: '80', required: true, half: true },
                { id: 'pulse', label: 'Pulse (bpm), from the monitor', type: 'number', min: 30, max: 220, placeholder: '70' },
                { id: 'notes', label: 'Notes (optional)', type: 'text', placeholder: 'e.g. after morning walk, left arm' }
            ]
        },
        pulse: {
            label: 'Resting heart rate', cat: 'vitals', mono: 'HR',
            fields: [
                { id: 'value', label: 'Resting heart rate (bpm)', type: 'number', min: 25, max: 220, placeholder: '62', required: true },
                { id: 'notes', label: 'Notes (optional)', type: 'text', placeholder: 'e.g. from Garmin, on waking' }
            ]
        },
        glucose: {
            label: 'Blood glucose', cat: 'vitals', mono: 'GL', hint: true,
            fields: [
                { id: 'value', label: 'Glucose', type: 'number', min: 20, max: 700, step: 'any', placeholder: '95', required: true, unitKey: 'glucose', half: true },
                { id: 'context', label: 'When taken', type: 'select', options: ['Fasting', 'Before meal', 'After meal', 'Bedtime', 'Random'], half: true },
                { id: 'notes', label: 'Notes (optional)', type: 'text' }
            ]
        },
        spo2: {
            label: 'Blood oxygen (SpO2)', cat: 'vitals', mono: 'O2',
            fields: [
                { id: 'value', label: 'SpO2 (%)', type: 'number', min: 50, max: 100, placeholder: '98', required: true },
                { id: 'notes', label: 'Notes (optional)', type: 'text' }
            ]
        },
        temperature: {
            label: 'Body temperature', cat: 'vitals', mono: 'TP',
            fields: [
                { id: 'value', label: 'Temperature', type: 'number', min: 30, max: 110, step: 'any', placeholder: '98.6', required: true, unitKey: 'temperature' },
                { id: 'notes', label: 'Notes (optional)', type: 'text' }
            ]
        },
        weight: {
            label: 'Weight', cat: 'body', mono: 'WT',
            fields: [
                { id: 'value', label: 'Weight', type: 'number', min: 1, max: 1500, step: 'any', placeholder: '160', required: true, unitKey: 'weight' },
                { id: 'notes', label: 'Notes (optional)', type: 'text', placeholder: 'e.g. morning, after workout' }
            ]
        },
        activity: {
            label: 'Activity & heart rate', cat: 'body', mono: 'AC',
            fields: [
                { id: 'activityType', label: 'Activity', type: 'select', options: ['Walk', 'Run', 'Strength training', 'Suryanamaskar', 'Yoga', 'Mindful breathing', 'Cycling', 'Swim', 'Sport', 'Other'], half: true },
                { id: 'duration', label: 'Duration (min)', type: 'number', min: 1, max: 900, placeholder: '30', half: true },
                { id: 'avgBpm', label: 'Avg heart rate (bpm), from watch', type: 'number', min: 30, max: 230, placeholder: '120', half: true },
                { id: 'maxBpm', label: 'Max heart rate (bpm)', type: 'number', min: 30, max: 230, placeholder: '150', half: true },
                { id: 'notes', label: 'Notes (optional)', type: 'text', placeholder: 'e.g. 12 rounds, brisk' }
            ]
        },
        steps: {
            label: 'Steps', cat: 'body', mono: 'ST',
            fields: [
                { id: 'value', label: 'Steps for the day', type: 'number', min: 0, max: 200000, placeholder: '8000', required: true },
                { id: 'notes', label: 'Notes (optional)', type: 'text' }
            ]
        },
        meal: {
            label: 'Meal', cat: 'lifestyle', mono: 'ML',
            fields: [
                { id: 'mealType', label: 'Meal', type: 'select', options: ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Drink'], half: true },
                { id: 'description', label: 'What you ate', type: 'text', placeholder: 'e.g. avocado toast & eggs, black coffee' }
            ]
        },
        water: {
            label: 'Water', cat: 'lifestyle', mono: 'WA',
            fields: [
                { id: 'amount', label: 'Amount', type: 'number', min: 1, max: 4000, placeholder: '8', required: true, unitKey: 'water' }
            ]
        },
        sleep: {
            label: 'Sleep', cat: 'lifestyle', mono: 'SL', dateOnly: true,
            fields: [
                { id: 'hours', label: 'Sleep previous night (hours)', type: 'number', min: 0, max: 24, step: 0.25, placeholder: '7.5', required: true, half: true },
                { id: 'quality', label: 'Quality', type: 'segment', scale: ['Poor', 'Fair', 'Okay', 'Good', 'Great'], half: true },
                { id: 'notes', label: 'Notes (optional)', type: 'text', placeholder: 'e.g. woke at 3am, late dinner' }
            ]
        },
        mood: {
            label: 'Mood & energy', cat: 'mind', mono: 'MD',
            fields: [
                { id: 'mood', label: 'Mood', type: 'segment', scale: ['Rough', 'Low', 'Okay', 'Good', 'Great'], required: true },
                { id: 'energy', label: 'Energy', type: 'segment', scale: ['Drained', 'Low', 'Okay', 'Good', 'High'] },
                { id: 'stress', label: 'Stress', type: 'segment', scale: ['None', 'Mild', 'Some', 'High', 'Severe'] },
                { id: 'notes', label: 'Notes (optional)', type: 'text' }
            ]
        },
        medication: {
            label: 'Medication / supplement', cat: 'mind', mono: 'RX',
            fields: [
                { id: 'name', label: 'Name', type: 'text', placeholder: 'e.g. Vitamin D, Amlodipine', required: true, half: true },
                { id: 'dose', label: 'Dose', type: 'text', placeholder: 'e.g. 5 mg, 1 tablet', half: true },
                { id: 'notes', label: 'Notes (optional)', type: 'text' }
            ]
        },
        symptom: {
            label: 'Symptom', cat: 'mind', mono: 'SY',
            fields: [
                { id: 'name', label: 'Symptom', type: 'text', placeholder: 'e.g. headache, dizziness', required: true, half: true },
                { id: 'severity', label: 'Severity', type: 'segment', scale: ['Mild', 'Low', 'Moderate', 'High', 'Severe'], half: true },
                { id: 'notes', label: 'Notes (optional)', type: 'text' }
            ]
        },
        note: {
            label: 'Wellness note', cat: 'mind', mono: 'NT',
            fields: [
                { id: 'notes', label: 'Anything worth remembering', type: 'text', placeholder: 'e.g. new medication started today', required: true }
            ]
        }
    },

    CATEGORIES: [
        { id: 'vitals', label: 'Vitals' },
        { id: 'body', label: 'Body & activity' },
        { id: 'lifestyle', label: 'Food, water & sleep' },
        { id: 'mind', label: 'Mind & care' }
    ],

    // ── Lifecycle ──────────────────────────────────────────────────────

    init() {
        this.loadData();
        this.setupEventListeners();
        this.render();
    },

    loadData() {
        const data = StorageManager.get('wellness');
        this.entries = (Array.isArray(data?.entries) ? data.entries : [])
            .filter(e => e && typeof e === 'object' && typeof e.time === 'string' && this.KINDS[e.kind]);
        const units = data?.settings?.units || {};
        for (const key of Object.keys(this.UNIT_OPTIONS)) {
            if (this.UNIT_OPTIONS[key].includes(units[key])) this.settings.units[key] = units[key];
        }
        this._importDismissed = !!data?.importDismissed;
    },

    saveData() {
        StorageManager.set('wellness', {
            entries: this.entries,
            settings: this.settings,
            importDismissed: this._importDismissed
        });
    },

    render() {
        WellnessUI.render(this);
    },

    getBreadcrumbs() {
        return [{ label: 'Wellness', action: null }];
    },

    // ── Formatting helpers ─────────────────────────────────────────────

    nowLocal() {
        const d = new Date();
        d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
        return d.toISOString().slice(0, 16);
    },

    todayKey() {
        return this.nowLocal().slice(0, 10);
    },

    fmtDate(key) {
        return new Date(key + 'T12:00:00').toLocaleDateString(undefined,
            { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    },

    fmtTime(iso) {
        return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    },

    minutesBetween(fromIso, toIso) {
        return Math.max(0, Math.round((new Date(toIso) - new Date(fromIso)) / 60000));
    },

    gapText(fromIso, toIso) {
        const mins = this.minutesBetween(fromIso, toIso);
        if (mins < 5) return 'right after';
        if (mins < 60) return mins + ' min after';
        const h = Math.floor(mins / 60), m = mins % 60;
        return h + ' h' + (m ? ' ' + m + ' min' : '') + ' after';
    },

    unitFor(unitKey) {
        return this.settings.units[unitKey] || this.UNIT_OPTIONS[unitKey][0];
    },

    // Convert a stored value (entry.unit) to the current display unit.
    convert(value, fromUnit, toUnit) {
        if (value == null || fromUnit === toUnit || !fromUnit || !toUnit) return value;
        const pair = fromUnit + '>' + toUnit;
        const table = {
            'lb>kg': v => v * 0.453592, 'kg>lb': v => v / 0.453592,
            'mg/dL>mmol/L': v => v / 18.016, 'mmol/L>mg/dL': v => v * 18.016,
            'F>C': v => (v - 32) * 5 / 9, 'C>F': v => v * 9 / 5 + 32,
            'oz>ml': v => v * 29.5735, 'ml>oz': v => v / 29.5735
        };
        return table[pair] ? table[pair](value) : value;
    },

    displayValue(entry, field, unitKey) {
        const unit = this.unitFor(unitKey);
        const v = this.convert(Number(entry[field]), entry.unit || unit, unit);
        const rounded = Math.round(v * 10) / 10;
        return { value: rounded, unit };
    },

    // ── Domain logic ───────────────────────────────────────────────────

    categorizeBp(sys, dia) {
        if (sys >= 180 || dia >= 120) return { label: 'Crisis', cls: 'wellness-cat-high' };
        if (sys >= 140 || dia >= 90) return { label: 'High (stage 2)', cls: 'wellness-cat-high' };
        if (sys >= 130 || dia >= 80) return { label: 'High (stage 1)', cls: 'wellness-cat-warn' };
        if (sys >= 120) return { label: 'Elevated', cls: 'wellness-cat-warn' };
        return { label: 'Normal', cls: 'wellness-cat-ok' };
    },

    sorted(kind) {
        const list = kind ? this.entries.filter(e => e.kind === kind) : this.entries.slice();
        return list.sort((a, b) => a.time.localeCompare(b.time));
    },

    latest(kind) {
        const list = this.sorted(kind);
        return list[list.length - 1] || null;
    },

    forDay(dateKey, kind) {
        return this.sorted(kind).filter(e => e.time.slice(0, 10) === dateKey);
    },

    waterTodayTotal() {
        const unit = this.unitFor('water');
        const total = this.forDay(this.todayKey(), 'water')
            .reduce((t, e) => t + this.convert(Number(e.amount) || 0, e.unit || unit, unit), 0);
        return { total: Math.round(total), unit };
    },

    // Meals/activities the same day at or before the given time, oldest first.
    // The correlation that makes readings interpretable ("1 h after lunch").
    entriesBefore(kind, time) {
        return this.sorted(kind).filter(e =>
            e.time.slice(0, 10) === time.slice(0, 10) && e.time <= time);
    },

    contextBefore(time) {
        const meals = this.entriesBefore('meal', time);
        const acts = this.entriesBefore('activity', time);
        return {
            lastMeal: meals[meals.length - 1] || null,
            lastActivity: acts[acts.length - 1] || null
        };
    },

    activityLabel(a, lowercase) {
        const esc = UIUtils.escapeHtml;
        const parts = [];
        if (a.duration) parts.push(esc(String(a.duration)) + ' min');
        if (a.avgBpm && a.maxBpm) parts.push('avg ' + esc(String(a.avgBpm)) + ' / max ' + esc(String(a.maxBpm)) + ' bpm');
        else if (a.avgBpm) parts.push('avg ' + esc(String(a.avgBpm)) + ' bpm');
        else if (a.maxBpm) parts.push('max ' + esc(String(a.maxBpm)) + ' bpm');
        const type = a.activityType || 'Activity';
        return esc(lowercase ? type.toLowerCase() : type) + (parts.length ? ' (' + parts.join(', ') + ')' : '');
    },

    avgBp(entries) {
        const list = entries.filter(e => e.kind === 'bp');
        if (!list.length) return null;
        const avg = (f) => Math.round(list.reduce((t, e) => t + (Number(e[f]) || 0), 0) / list.length);
        const withPulse = list.filter(e => e.pulse);
        return {
            count: list.length,
            systolic: avg('systolic'),
            diastolic: avg('diastolic'),
            pulse: withPulse.length
                ? Math.round(withPulse.reduce((t, e) => t + Number(e.pulse), 0) / withPulse.length)
                : null
        };
    },

    sinceDays(days) {
        const cut = new Date();
        cut.setDate(cut.getDate() - days);
        const iso = cut.toISOString().slice(0, 10);
        return this.entries.filter(e => e.time.slice(0, 10) >= iso);
    },

    // Summary used by the tiles AND the assistant's wellness_summary tool.
    summary() {
        const latestBp = this.latest('bp');
        const weights = this.sorted('weight');
        const latestWeight = weights[weights.length - 1] || null;
        const prevWeight = weights[weights.length - 2] || null;
        const latestSleep = this.latest('sleep');
        const latestGlucose = this.latest('glucose');
        const moodToday = this.forDay(this.todayKey(), 'mood');
        const water = this.waterTodayTotal();
        const days = new Set(this.entries.map(e => e.time.slice(0, 10)));

        let weightDelta = null;
        if (latestWeight && prevWeight) {
            const unit = this.unitFor('weight');
            const a = this.convert(Number(latestWeight.value), latestWeight.unit || unit, unit);
            const b = this.convert(Number(prevWeight.value), prevWeight.unit || unit, unit);
            weightDelta = Math.round((a - b) * 10) / 10;
        }

        return {
            totalEntries: this.entries.length,
            daysTracked: days.size,
            latestBp: latestBp ? {
                time: latestBp.time, systolic: latestBp.systolic, diastolic: latestBp.diastolic,
                pulse: latestBp.pulse || null,
                category: this.categorizeBp(Number(latestBp.systolic), Number(latestBp.diastolic)).label
            } : null,
            bpLast7Days: this.avgBp(this.sinceDays(7)),
            bpLast30Days: this.avgBp(this.sinceDays(30)),
            latestWeight: latestWeight
                ? Object.assign(this.displayValue(latestWeight, 'value', 'weight'), { time: latestWeight.time, delta: weightDelta })
                : null,
            latestGlucose: latestGlucose
                ? Object.assign(this.displayValue(latestGlucose, 'value', 'glucose'), { time: latestGlucose.time, context: latestGlucose.context || null })
                : null,
            lastSleep: latestSleep ? { date: latestSleep.time.slice(0, 10), hours: Number(latestSleep.hours), quality: latestSleep.quality || null } : null,
            waterToday: water.total ? water : null,
            moodToday: moodToday.length
                ? Math.round(moodToday.reduce((t, e) => t + Number(e.mood || 0), 0) / moodToday.length)
                : null
        };
    },

    // ── Chart data ─────────────────────────────────────────────────────

    CHART_METRICS: [
        { id: 'bp', label: 'Blood pressure' },
        { id: 'pulse', label: 'Pulse' },
        { id: 'weight', label: 'Weight' },
        { id: 'glucose', label: 'Glucose' },
        { id: 'sleep', label: 'Sleep' },
        { id: 'water', label: 'Water' },
        { id: 'mood', label: 'Mood' },
        { id: 'steps', label: 'Steps' }
    ],

    _inRange(entries, days) {
        if (!days) return entries;
        const cut = new Date();
        cut.setDate(cut.getDate() - days);
        const iso = cut.toISOString().slice(0, 10);
        return entries.filter(e => e.time.slice(0, 10) >= iso);
    },

    _dailyPoints(kind, field, mode) {
        const byDay = {};
        for (const e of this._inRange(this.sorted(kind), this.chartRange)) {
            const day = e.time.slice(0, 10);
            const unit = e.unit;
            let v = Number(e[field]);
            if (kind === 'water') v = this.convert(v, unit || this.unitFor('water'), this.unitFor('water'));
            if (!byDay[day]) byDay[day] = [];
            if (!isNaN(v)) byDay[day].push(v);
        }
        return Object.keys(byDay).sort().map(day => {
            const vals = byDay[day];
            let v;
            if (mode === 'sum') v = vals.reduce((a, b) => a + b, 0);
            else if (mode === 'last') v = vals[vals.length - 1];
            else v = vals.reduce((a, b) => a + b, 0) / vals.length;
            return { t: new Date(day + 'T12:00:00').getTime(), v: Math.round(v * 10) / 10, timeLabel: this.fmtDate(day) };
        });
    },

    _pointPerEntry(kind, field, unitKey) {
        return this._inRange(this.sorted(kind), this.chartRange)
            .map(e => {
                let v = Number(e[field]);
                if (unitKey) v = this.convert(v, e.unit || this.unitFor(unitKey), this.unitFor(unitKey));
                return isNaN(v) ? null : {
                    t: new Date(e.time).getTime(), v: Math.round(v * 10) / 10,
                    timeLabel: this.fmtDate(e.time.slice(0, 10)) + ', ' + this.fmtTime(e.time)
                };
            })
            .filter(Boolean);
    },

    chartData() {
        const m = this.chartMetric;
        if (m === 'bp') {
            const pts = this._inRange(this.sorted('bp'), this.chartRange);
            const mk = (f) => pts.map(e => ({
                t: new Date(e.time).getTime(), v: Number(e[f]),
                timeLabel: this.fmtDate(e.time.slice(0, 10)) + ', ' + this.fmtTime(e.time)
            }));
            return {
                unit: 'mmHg',
                refLines: [{ v: 120, label: '120' }, { v: 80, label: '80' }],
                series: [
                    { name: 'Systolic', cls: 'a', points: mk('systolic') },
                    { name: 'Diastolic', cls: 'b', points: mk('diastolic') }
                ]
            };
        }
        if (m === 'pulse') {
            // BP-cuff pulse and standalone resting-HR entries, one series.
            const pts = this._inRange(this.sorted(), this.chartRange)
                .map(e => {
                    if (e.kind === 'bp' && e.pulse) return { t: new Date(e.time).getTime(), v: Number(e.pulse), timeLabel: this.fmtDate(e.time.slice(0, 10)) + ', ' + this.fmtTime(e.time) };
                    if (e.kind === 'pulse') return { t: new Date(e.time).getTime(), v: Number(e.value), timeLabel: this.fmtDate(e.time.slice(0, 10)) + ', ' + this.fmtTime(e.time) };
                    return null;
                })
                .filter(p => p && !isNaN(p.v))
                .sort((a, b) => a.t - b.t);
            return { unit: 'bpm', series: [{ name: 'Pulse', cls: 'a', points: pts }] };
        }
        if (m === 'weight') return { unit: this.unitFor('weight'), series: [{ name: 'Weight', cls: 'a', points: this._pointPerEntry('weight', 'value', 'weight') }] };
        if (m === 'glucose') return { unit: this.unitFor('glucose'), series: [{ name: 'Glucose', cls: 'a', points: this._pointPerEntry('glucose', 'value', 'glucose') }] };
        if (m === 'sleep') return { unit: 'hours', series: [{ name: 'Sleep', cls: 'a', points: this._dailyPoints('sleep', 'hours', 'last') }] };
        if (m === 'water') return { unit: this.unitFor('water') + '/day', series: [{ name: 'Water', cls: 'a', points: this._dailyPoints('water', 'amount', 'sum') }] };
        if (m === 'mood') return { unit: '1–5', series: [{ name: 'Mood', cls: 'a', points: this._dailyPoints('mood', 'mood', 'avg') }] };
        if (m === 'steps') return { unit: 'steps/day', series: [{ name: 'Steps', cls: 'a', points: this._dailyPoints('steps', 'value', 'last') }] };
        return { unit: '', series: [] };
    },

    // ── Mutations ──────────────────────────────────────────────────────

    addEntry(kind, values) {
        const entry = Object.assign({ id: UIUtils.generateId(), kind, createdAt: new Date().toISOString() }, values);
        this.entries.push(entry);
        this.saveData();
        return entry;
    },

    updateEntry(id, values) {
        const entry = this.entries.find(e => e.id === id);
        if (!entry) return null;
        Object.assign(entry, values, { modifiedAt: new Date().toISOString() });
        this.saveData();
        return entry;
    },

    deleteEntry(id) {
        this.entries = this.entries.filter(e => e.id !== id);
        this.saveData();
    },

    quickWater() {
        const unit = this.unitFor('water');
        this.addEntry('water', { time: this.nowLocal(), amount: unit === 'ml' ? 250 : 8, unit });
        UIUtils.showToast('Water logged', 'success');
        this.render();
    },

    // ── Legacy import — the bp-tracker user app (~/Anjadhe/apps/bp-tracker)
    // stored its data in the userapp-bp-tracker blob. Offer a one-time,
    // non-destructive import into the built-in app. ─────────────────────

    legacyData() {
        const blob = StorageManager.get('userapp-bp-tracker');
        if (!blob || typeof blob !== 'object') return null;
        const readings = Array.isArray(blob.readings) ? blob.readings : [];
        const meals = Array.isArray(blob.meals) ? blob.meals : [];
        const activities = Array.isArray(blob.activities) ? blob.activities : [];
        const dayinfo = blob.dayinfo && typeof blob.dayinfo === 'object' ? blob.dayinfo : {};
        const count = readings.length + meals.length + activities.length + Object.keys(dayinfo).length;
        return count ? { readings, meals, activities, dayinfo, count } : null;
    },

    shouldOfferImport() {
        return !this._importDismissed && this.entries.length === 0 && !!this.legacyData();
    },

    importLegacy() {
        const legacy = this.legacyData();
        if (!legacy) return 0;
        let n = 0;
        const push = (kind, time, values) => {
            if (typeof time !== 'string' || !time) return;
            this.entries.push(Object.assign({
                id: UIUtils.generateId(), kind, time: time.slice(0, 16),
                createdAt: new Date().toISOString(), importedFrom: 'bp-tracker'
            }, values));
            n++;
        };
        for (const r of legacy.readings) {
            push('bp', r.time, { systolic: Number(r.systolic), diastolic: Number(r.diastolic), pulse: r.pulse ? Number(r.pulse) : null, notes: r.notes || '' });
        }
        for (const m of legacy.meals) {
            push('meal', m.time, { mealType: m.type || 'Snack', description: m.description || '' });
        }
        for (const a of legacy.activities) {
            push('activity', a.time, {
                activityType: a.type || 'Other',
                duration: a.duration ? Number(a.duration) : null,
                avgBpm: a.avgBpm ? Number(a.avgBpm) : null,
                maxBpm: a.maxBpm ? Number(a.maxBpm) : null,
                notes: a.notes || ''
            });
        }
        for (const dateKey of Object.keys(legacy.dayinfo)) {
            const info = legacy.dayinfo[dateKey];
            if (info && info.sleep !== '' && info.sleep != null) {
                push('sleep', dateKey + 'T07:00', { hours: Number(info.sleep), notes: [info.exercise, info.food].filter(Boolean).join('; ') });
            }
        }
        this._importDismissed = true;
        this.saveData();
        UIUtils.showToast(`Imported ${n} entries from your custom tracker`, 'success');
        this.render();
        return n;
    },

    dismissImport() {
        this._importDismissed = true;
        this.saveData();
        this.render();
    },

    // ── Event wiring ───────────────────────────────────────────────────

    setupEventListeners() {
        if (this._wired) return;
        this._wired = true;

        const logBtn = document.getElementById('wellness-log-btn');
        const logMenu = document.getElementById('wellness-log-menu');
        logBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (logMenu.hidden) {
                logMenu.innerHTML = WellnessUI.logMenuHtml(this);
                logMenu.hidden = false;
            } else {
                logMenu.hidden = true;
            }
        });
        logMenu.addEventListener('click', (e) => {
            const item = e.target.closest('[data-kind]');
            if (!item) return;
            logMenu.hidden = true;
            this.openForm(item.dataset.kind);
        });
        document.addEventListener('click', () => { logMenu.hidden = true; });

        document.getElementById('wellness-units-btn').addEventListener('click', () => this.openUnitsModal());

        // Everything inside the body is delegated on data-action, so render()
        // can rebuild innerHTML freely without re-wiring.
        document.getElementById('wellness-body').addEventListener('click', (e) => {
            const el = e.target.closest('[data-action]');
            if (!el) return;
            const action = el.dataset.action;
            if (action === 'log') this.openForm(el.dataset.kind);
            if (action === 'edit') this.openForm(null, el.dataset.id);
            if (action === 'delete') {
                const id = el.dataset.id;
                UIUtils.confirm('Delete entry', 'Delete this entry? This cannot be undone.').then(ok => {
                    if (!ok) return;
                    this.deleteEntry(id);
                    UIUtils.showToast('Entry deleted', 'info');
                    this.render();
                });
            }
            if (action === 'quick-water') this.quickWater();
            // The "Log by chatting" pill: a fresh conversation, so the
            // question isn't dropped into whatever chat was open last.
            if (action === 'ask' && typeof AgentUI !== 'undefined') {
                AgentUI.askWithPrompt(el.dataset.ask, { newChat: true });
            }
            if (action === 'chart-metric') { this.chartMetric = el.dataset.metric; this.render(); }
            if (action === 'chart-range') { this.chartRange = Number(el.dataset.range); this.render(); }
            if (action === 'import-legacy') this.importLegacy();
            if (action === 'dismiss-import') this.dismissImport();
        });
        document.getElementById('wellness-body').addEventListener('change', (e) => {
            if (e.target.id === 'wellness-history-filter') {
                this.historyFilter = e.target.value;
                this.render();
            }
        });
    },

    // ── Log/edit modal ─────────────────────────────────────────────────

    openForm(kind, editId) {
        const existing = editId ? this.entries.find(e => e.id === editId) : null;
        if (editId && !existing) return;
        const k = existing ? existing.kind : kind;
        const spec = this.KINDS[k];
        if (!spec) return;

        const content = document.createElement('div');
        content.innerHTML = WellnessUI.formHtml(this, k, existing);

        const modal = Modal.create({
            title: (existing ? 'Edit: ' : 'Log: ') + spec.label,
            content,
            className: 'wellness-modal',
            buttons: [
                { text: 'Cancel', className: 'secondary-btn' },
                {
                    text: existing ? 'Save changes' : 'Save',
                    className: 'primary-btn',
                    onClick: () => {
                        const values = this._collectForm(content, spec);
                        if (!values) return; // validation failed, keep modal open
                        if (existing) this.updateEntry(existing.id, values);
                        else this.addEntry(k, values);
                        UIUtils.showToast(existing ? 'Entry updated' : spec.label + ' saved', 'success');
                        modal.close();
                        this.render();
                    }
                }
            ]
        });

        WellnessUI.wireForm(this, content, k);
    },

    _collectForm(root, spec) {
        const values = {};
        const timeInput = root.querySelector('[data-field="__time"]');
        let time = timeInput ? timeInput.value : '';
        if (spec.dateOnly) time = time ? time + 'T07:00' : '';
        if (!time) { UIUtils.showToast('Please set the time', 'error'); return null; }
        values.time = time.slice(0, 16);

        for (const f of spec.fields) {
            const input = root.querySelector(`[data-field="${f.id}"]`);
            if (!input) continue;
            let v;
            if (f.type === 'segment') {
                const active = input.querySelector('.wellness-seg-btn.active');
                v = active ? Number(active.dataset.value) : null;
            } else if (f.type === 'number') {
                v = input.value === '' ? null : Number(input.value);
                if (v != null && (isNaN(v) || (f.min != null && v < f.min) || (f.max != null && v > f.max))) {
                    UIUtils.showToast(`${f.label.split('(')[0].trim()} looks out of range`, 'error');
                    return null;
                }
            } else {
                v = input.value.trim();
            }
            if (f.required && (v == null || v === '')) {
                UIUtils.showToast(`${f.label.split('(')[0].trim()} is required`, 'error');
                return null;
            }
            values[f.id] = v;
            if (f.unitKey) values.unit = this.unitFor(f.unitKey);
        }
        return values;
    },

    openUnitsModal() {
        const content = document.createElement('div');
        content.innerHTML = WellnessUI.unitsHtml(this);
        const modal = Modal.create({
            title: 'Measurement units',
            content,
            className: 'wellness-modal',
            buttons: [
                { text: 'Cancel', className: 'secondary-btn' },
                {
                    text: 'Save', className: 'primary-btn',
                    onClick: () => {
                        content.querySelectorAll('select[data-unit-key]').forEach(sel => {
                            this.settings.units[sel.dataset.unitKey] = sel.value;
                        });
                        this.saveData();
                        modal.close();
                        this.render();
                    }
                }
            ]
        });
    }
};

AppManager.register('wellness', WellnessApp);

// Ambient context for the assistant: a compact snapshot of the latest
// numbers whenever the user chats while looking at the Wellness app.
if (typeof AgentContext !== 'undefined') {
    AgentContext.register('wellness', () => {
        const s = WellnessApp.summary();
        if (!s.totalEntries) return null;
        const lines = [];
        if (s.latestBp) lines.push(`Latest blood pressure: ${s.latestBp.systolic}/${s.latestBp.diastolic}` + (s.latestBp.pulse ? `, pulse ${s.latestBp.pulse}` : '') + ` (${s.latestBp.category}, ${s.latestBp.time})`);
        if (s.bpLast7Days) lines.push(`7-day BP average: ${s.bpLast7Days.systolic}/${s.bpLast7Days.diastolic} over ${s.bpLast7Days.count} readings`);
        if (s.latestWeight) lines.push(`Latest weight: ${s.latestWeight.value} ${s.latestWeight.unit}` + (s.latestWeight.delta != null ? ` (${s.latestWeight.delta >= 0 ? '+' : ''}${s.latestWeight.delta} vs previous)` : ''));
        if (s.latestGlucose) lines.push(`Latest glucose: ${s.latestGlucose.value} ${s.latestGlucose.unit}` + (s.latestGlucose.context ? ` (${s.latestGlucose.context})` : ''));
        if (s.lastSleep) lines.push(`Last sleep: ${s.lastSleep.hours} h on ${s.lastSleep.date}`);
        if (s.waterToday) lines.push(`Water today: ${s.waterToday.total} ${s.waterToday.unit}`);
        return {
            recordKey: 'wellness:summary',
            recordLabel: 'Wellness overview',
            title: 'WELLNESS SNAPSHOT',
            body: `The user is viewing their Wellness tracker (${s.totalEntries} entries over ${s.daysTracked} days). Use the wellness tools (list_wellness, wellness_summary, log_wellness) for details or to log data.\n\n${lines.join('\n')}`,
            suggestedPrompts: [
                'How has my blood pressure trended lately?',
                'Any pattern between my sleep and my readings?',
                'Log my blood pressure'
            ]
        };
    });
}
