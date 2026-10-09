/**
 * WellnessFold — the health log becomes commitments (2026-10-05, the fold
 * toward the first wedge: "a thing a person tracks is a commitment").
 *
 * The Wellness app kept one `entries` array in the synced `wellness` blob
 * ({id, kind, time, ...fields}). Without the app, every entry is filed as a
 * REPORT on a day of a tracking commitment — "Track blood pressure", "Take
 * Amlodipine", "Exercise" — through the same shape the chat uses
 * (`Commitments.report`: the person's words in `log[day]`, the day marked
 * done). The words are written by code from the entry's own fields; nothing
 * is model-written. Charts are gone; "how has my BP been" is a read of the
 * commitment's days.
 *
 * Runs ONCE per Mac (`localStorage['wellness-folded']`), idempotent anyway:
 * commitments carry fixed ids (`wellness-<kind>`, `wellness-med-<slug>`)
 * and a day never keeps the same quote twice. ONE save, ONE ledger entry.
 * The `wellness` blob is left as it was (user data, unread).
 *
 * Pure parts (`lines`, `quote`) are Node-testable: tests/wellness-fold-test.js.
 */
const WellnessFold = {
    MARK: 'wellness-folded',

    /**
     * One tracking commitment per kind; medications one per name. A
     * medication repeats daily (that is what one is), so each logged day is
     * marked done and Today shows it. Everything else is an OPEN, undated
     * commitment that simply holds its days: a reading taken now and then
     * must not become fourteen "Anytime" rows on Today.
     */
    TRACKS: {
        bp:          { title: 'Track blood pressure' },
        pulse:       { title: 'Track resting heart rate' },
        glucose:     { title: 'Track blood glucose' },
        spo2:        { title: 'Track blood oxygen' },
        temperature: { title: 'Track body temperature' },
        weight:      { title: 'Track weight' },
        activity:    { title: 'Exercise' },
        steps:       { title: 'Track steps' },
        meal:        { title: 'Track meals' },
        water:       { title: 'Drink water' },
        sleep:       { title: 'Track sleep' },
        mood:        { title: 'Check in on mood' },
        symptom:     { title: 'Track symptoms' },
        note:        { title: 'Wellness notes' }
    },

    _slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x'; },
    _num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : (v !== '' && v != null && Number.isFinite(Number(v)) ? Number(v) : null); },
    _time(t) {
        const m = /T(\d{2}):(\d{2})/.exec(String(t || ''));
        if (!m) return '';
        const h = +m[1], mm = m[2];
        return `${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
    },

    /** The words for one entry, from its own fields; '' when it holds nothing. */
    quote(e, units = {}) {
        const n = this._num.bind(this);
        const u = (k, d) => units[k] || d;
        const notes = e.notes ? String(e.notes).trim() : '';
        let body = '';
        switch (e.kind) {
            case 'bp': body = n(e.systolic) != null && n(e.diastolic) != null ? `${n(e.systolic)}/${n(e.diastolic)}${n(e.pulse) != null ? `, pulse ${n(e.pulse)}` : ''}` : ''; break;
            case 'pulse': body = n(e.value) != null ? `${n(e.value)} bpm` : ''; break;
            case 'glucose': body = n(e.value) != null ? `${n(e.value)} ${e.unit || u('glucose', 'mg/dL')}${e.context ? `, ${String(e.context).toLowerCase()}` : ''}` : ''; break;
            case 'spo2': body = n(e.value) != null ? `${n(e.value)}%` : ''; break;
            case 'temperature': body = n(e.value) != null ? `${n(e.value)} °${e.unit || u('temperature', 'F')}` : ''; break;
            case 'weight': body = n(e.value) != null ? `${n(e.value)} ${e.unit || u('weight', 'lb')}` : ''; break;
            case 'activity': {
                const parts = [e.activityType, n(e.duration) != null ? `${n(e.duration)} min` : '', n(e.distance) != null ? `${n(e.distance)} ${e.unit || u('distance', 'mi')}` : '',
                    n(e.avgBpm) != null ? `avg ${n(e.avgBpm)} bpm` : '', n(e.maxBpm) != null ? `max ${n(e.maxBpm)} bpm` : ''].filter(Boolean);
                body = parts.join(', '); break;
            }
            case 'steps': body = n(e.value) != null ? `${n(e.value)} steps` : ''; break;
            case 'meal': body = [e.mealType, e.description].filter(Boolean).join(': '); break;
            case 'water': body = n(e.amount) != null ? `${n(e.amount)} ${e.unit || u('water', 'oz')}` : ''; break;
            case 'sleep': body = n(e.hours) != null ? `${n(e.hours)} h${e.quality ? `, ${String(e.quality).toLowerCase()}` : ''}` : ''; break;
            case 'mood': body = [e.mood ? `mood ${String(e.mood).toLowerCase()}` : '', e.energy ? `energy ${String(e.energy).toLowerCase()}` : '', e.stress ? `stress ${String(e.stress).toLowerCase()}` : ''].filter(Boolean).join(', '); break;
            case 'medication': body = e.dose ? String(e.dose) : 'taken'; break;
            case 'symptom': body = [e.name, e.severity ? String(e.severity).toLowerCase() : ''].filter(Boolean).join(', '); break;
            case 'note': body = ''; break;
            default: return '';
        }
        const text = [body, notes].filter(Boolean).join(' — ');
        if (!text) return '';
        const at = this._time(e.time);
        return `${at ? at + ': ' : ''}${text}`.replace(/\s+/g, ' ').trim().slice(0, 200);
    },

    /**
     * Every entry as a line: { id, title, day, quote }. Pure. Entries with no
     * day, an unknown kind or nothing to say are skipped and counted.
     */
    lines(blob) {
        const out = [], skipped = [];
        const entries = Array.isArray(blob && blob.entries) ? blob.entries : [];
        const units = (blob && blob.settings && blob.settings.units) || {};
        for (const e of entries) {
            if (!e || typeof e !== 'object') { skipped.push(e); continue; }
            const day = String(e.time || '').slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !(this.TRACKS[e.kind] || e.kind === 'medication')) { skipped.push(e); continue; }
            let id, title;
            if (e.kind === 'medication') {
                const name = String(e.name || '').trim();
                if (!name) { skipped.push(e); continue; }
                id = `wellness-med-${this._slug(name)}`; title = `Take ${name}`;
            } else { id = `wellness-${e.kind}`; title = this.TRACKS[e.kind].title; }
            const quote = this.quote(e, units);
            if (!quote) { skipped.push(e); continue; }
            out.push({ id, title, day, quote });
        }
        out.sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
        return { lines: out, skipped: skipped.length };
    },

    /**
     * File the lines into the commitments store in ONE write. Returns what
     * was made and kept. `C` is Commitments (passed for tests).
     */
    apply(blob, C, now = Date.now()) {
        const { lines, skipped } = this.lines(blob);
        if (!lines.length) return { created: [], reports: 0, skipped };
        const d = C._load();
        const at = new Date(now).toISOString();
        const created = [];
        let reports = 0;
        for (const l of lines) {
            const daily = l.id.startsWith('wellness-med-');
            let c = d.items[l.id];
            if (!c) {
                c = C.blank(l.id, at);
                c.title = l.title;
                if (daily) { c.repeat = { rule: 'daily', days: [] }; c.when = { date: l.day, time: null, end: null }; }   // from the first day it was taken
                c.origin = { kind: 'wellness' };
                d.items[l.id] = c;
                delete d.tombstones[l.id];
                created.push(l.id);
            } else if (daily && c.when && c.when.date && l.day < c.when.date) {
                c.when.date = l.day;   // a repeat never fires before its anchor
            }
            c.log = c.log || {};
            const day = c.log[l.day] || [];
            if (!day.some(e => e.quote === l.quote)) { c.log[l.day] = [...day, { at, quote: l.quote }]; reports++; }
            if (daily) { c.history = c.history || {}; if (!c.history[l.day]) c.history[l.day] = 'done'; }
            c.updatedAt = at;
        }
        if (created.length || reports) {
            C._ledger({ op: 'fold', target: null, by: 'app', why: 'the health log became commitments', after: { created: created.length, reports } });
            C._save();
        }
        return { created, reports, skipped };
    },

    /** Startup: once per Mac, only with a health log to fold and the commitments store running. */
    runOnce() {
        try {
            if (typeof localStorage !== 'undefined' && localStorage.getItem(this.MARK)) return null;
            if (typeof Commitments === 'undefined' || !Commitments._inited || typeof StorageManager === 'undefined') return null;
            const blob = StorageManager.get('wellness');
            const r = (blob && Array.isArray(blob.entries) && blob.entries.length) ? this.apply(blob, Commitments) : { created: [], reports: 0, skipped: 0 };
            try { localStorage.setItem(this.MARK, new Date().toISOString()); } catch { /* per-Mac mark only */ }
            if (r.created.length || r.reports) {
                console.log(`[wellness-fold] ${r.reports} entries filed on ${r.created.length} new commitments (${r.skipped} skipped)`);
                try { Commitments.project(); } catch { /* the bridge catches up on the next write */ }
            }
            return r;
        } catch (e) { console.warn('[wellness-fold] failed:', e); return null; }
    }
};

if (typeof module !== 'undefined') module.exports = WellnessFold;
