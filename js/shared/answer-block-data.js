'use strict';
// Shared read-only block contracts and formatting (B1-B5). No UI or host access.
const AnswerBlockData = {
    MAX_ROWS: 60,
    MAX_POINTS: 400,
    DAY_WORDS: { done: 'done', skipped: 'skipped', missed: 'not marked', open: 'not yet' },
    daySummary(days) {
        const n = k => days.filter(d => d.state === k).length;
        return [`${n('done')} done`, n('skipped') ? `${n('skipped')} skipped` : '', n('missed') ? `${n('missed')} not marked` : ''].filter(Boolean).join(' · ');
    },
    /** Code formats; the model never does (B3). */
    formatValue(v, format, signed) {
        if (v == null || v === '') return '';
        if (format === 'text') return String(v);
        if (format === 'date') {
            // A bare day ("2026-04-09") is a LOCAL day, not UTC midnight —
            // read as UTC it shows as the day before west of Greenwich.
            const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
            const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
            if (Number.isNaN(d.getTime())) return String(v);
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
        }
        const n = Number(v);
        if (!Number.isFinite(n)) return String(v);
        // A time of day kept as minutes after midnight (a bedtime, docs/COACH.md).
        if (format === 'clock') { const m = ((Math.round(n) % 1440) + 1440) % 1440, h = Math.floor(m / 60); return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; }
        const sign = signed ? (n > 0 ? '+' : n < 0 ? '−' : '') : (n < 0 ? '−' : '');
        const a = Math.abs(n);
        let body;
        switch (format) {
            case 'money': body = '$' + a.toLocaleString(undefined, { maximumFractionDigits: 0 }); break;
            case 'money2': body = '$' + a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); break;
            case 'pct': body = a.toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%'; break;
            case 'shares': body = a.toLocaleString(undefined, { maximumFractionDigits: 4 }); break;
            default: body = a.toLocaleString(undefined, { maximumFractionDigits: 2 });
        }
        return sign + body;
    },

    /** The tone class for a signed value: state, never theme (B3). */
    tone(v, signed) {
        if (!signed) return '';
        const n = Number(v);
        if (!Number.isFinite(n) || n === 0) return '';
        return n > 0 ? ' is-up' : ' is-down';
    },

    /** '-value' → by value descending; 'ticker' ascending. Stable; strings compare as text. */
    sortRows(rows, sort, columns) {
        if (!sort) return rows.slice();
        const desc = sort[0] === '-';
        const key = desc ? sort.slice(1) : sort;
        const col = (columns || []).find(c => c.key === key);
        if (!col) return rows.slice();
        const textual = col.format === 'text' || col.format === 'date';
        return rows.slice().sort((a, b) => {
            const av = a[key], bv = b[key];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            let c;
            if (textual) c = String(av).localeCompare(String(bv));
            else c = Number(av) - Number(bv);
            return desc ? -c : c;
        });
    },

    /** Trimmed, size-capped copy of a builder's block, or null when it has nothing to draw. */
    normalize(block) {
        if (!block || typeof block !== 'object') return null;
        const out = { kind: block.kind };
        if (block.title) out.title = String(block.title).slice(0, 120);
        if (block.kind === 'stats') {
            out.items = (block.items || []).filter(i => i && i.label != null && i.value != null).slice(0, 8)
                .map(i => ({ label: String(i.label).slice(0, 60), value: i.value, format: i.format || 'number', signed: !!i.signed, sub: i.sub ? String(i.sub).slice(0, 60) : undefined }));
            return out.items.length ? out : null;
        }
        if (block.kind === 'table') {
            out.columns = (block.columns || []).filter(c => c && c.key).slice(0, 10)
                .map(c => ({ key: String(c.key), label: String(c.label || c.key).slice(0, 40), format: c.format || 'text', signed: !!c.signed, align: c.align }));
            out.rows = (block.rows || []).filter(r => r && typeof r === 'object').slice(0, this.MAX_ROWS);
            if (block.sort) out.sort = String(block.sort).slice(0, 40);
            return out.columns.length && out.rows.length ? out : null;
        }
        if (block.kind === 'bar') {
            out.items = (block.items || []).filter(i => i && i.label != null && Number.isFinite(Number(i.value))).slice(0, 20)
                .map(i => ({ label: String(i.label).slice(0, 60), value: Number(i.value), format: i.format || 'number' }));
            return out.items.length ? out : null;
        }
        if (block.kind === 'line') {
            const pts = (block.points || []).filter(p => p && Number.isFinite(Number(p.y)));
            // Thin evenly, never truncate: the last point is the one that matters.
            const step = Math.max(1, Math.ceil(pts.length / this.MAX_POINTS));
            out.points = pts.filter((p, i) => i % step === 0 || i === pts.length - 1).map(p => ({ x: p.x, y: Number(p.y) }));
            out.format = block.format || 'number';
            out.signed = block.signed !== false;
            if (block.label) out.label = String(block.label).slice(0, 60);
            return out.points.length >= 2 ? out : null;
        }
        if (block.kind === 'days') {
            const ok = new Set(['done', 'skipped', 'missed', 'open']);
            out.days = (block.days || []).filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date)) && ok.has(d.state)).slice(-62)
                .map(d => ({ date: String(d.date), state: d.state }));
            return out.days.length ? out : null;
        }
        return null;
    },

};
if (typeof module !== 'undefined' && module.exports) module.exports = AnswerBlockData;
