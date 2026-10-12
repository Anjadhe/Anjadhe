'use strict';
// CS1 Schedule and lifecycle invariants are grouped; independent prose merges.
// CS2 A day's mark, quoted reports/figures and time move travel together.
// CS3 Concurrent versions remain reviewable; projection never installs data.
// CS4 Author only against a complete, observed baseline and immutable identity.
// CS5 Unsupported history blocks enrollment; local caches/ledger stay intact.
const CommitmentSync = Object.freeze({
    object: v => v !== null && typeof v === 'object' && !Array.isArray(v),
    id: v => typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[^A-Za-z0-9._:-]/.test(v),
    text: (v, n, required = false) => typeof v === 'string' && v.length <= n && (!required || v.length > 0),
    exact(v, keys) { return this.object(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(','); },
    date(v) {
        if (!this.text(v, 10) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$(?![\s\S])/.test(v)) return false;
        const [y, m, d] = v.split('-').map(Number), leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
        return y > 0 && m >= 1 && m <= 12 && d >= 1 && d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    },
    clock: v => typeof v === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$(?![\s\S])/.test(v),
    list(v, max) { return Array.isArray(v) && v.length <= max + 1 && v.every((n, i) => Number.isInteger(n) && n >= 0 && n <= max && (!i || n > v[i - 1])); },
    timePair(v) { return this.exact(v, ['time', 'end']) && (v.time === null || this.clock(v.time)) && (v.end === null || this.clock(v.end)) && (v.end === null || v.time !== null && v.end >= v.time); },
    measure(v) { return this.exact(v, ['name', 'value', 'unit']) && this.measureName(v.name) && Number.isFinite(v.value) && this.unit(v.unit) && (v.unit !== 'time' || Number.isInteger(v.value) && v.value >= 0 && v.value < 1440); },
    measureName: v => typeof v === 'string' && v.length <= 40 && /^[a-z0-9][a-z0-9 _-]*$(?![\s\S])/.test(v) && /[a-z]/.test(v),
    unit: v => typeof v === 'string' && v.length <= 16 && v === v.toLowerCase().trim() && !/[\r\n\t]/.test(v),
    validField(type, key, v) {
        if (type === 'commitment-day') {
            if (key !== 'day' || !this.exact(v, ['commitmentId', 'date', 'mark', 'log', 'moved']) || !this.id(v.commitmentId) || !this.date(v.date) || ![null, 'done', 'dropped'].includes(v.mark)) return false;
            if (v.moved !== null && (!this.timePair(v.moved) || v.moved.time === null)) return false;
            return Array.isArray(v.log) && v.log.length <= 128 && v.log.every(e => {
                if (!this.object(e) || Object.keys(e).some(k => !['at', 'quote', 'plan', 'measures'].includes(k)) || !this.text(e.at, 64, true) || !this.text(e.quote, 200, true)) return false;
                if (Object.hasOwn(e, 'plan') && typeof e.plan !== 'boolean') return false;
                if (!Object.hasOwn(e, 'measures')) return true;
                return e.plan !== true && Array.isArray(e.measures) && e.measures.length <= 8 && e.measures.every(m => this.measure(m)) && new Set(e.measures.map(m => m.name)).size === e.measures.length;
            });
        }
        if (type !== 'commitment') return false;
        if (key === 'title') return this.text(v, 200, true);
        if (key === 'note') return this.text(v, 20000);
        if (key === 'outcome') return v === null || this.text(v, 2000);
        if (key === 'parent') return v === null || this.id(v);
        if (key === 'waitingOn') return v === null || this.exact(v, ['who', 'since']) && this.text(v.who, 80, true) && this.date(v.since);
        if (key === 'created') return this.exact(v, ['at', 'origin', 'shape']) && this.text(v.at, 64, true) && [null, 'task', 'goal'].includes(v.shape) && this.object(v.origin) &&
            Object.keys(v.origin).every(k => ['kind', 'ref'].includes(k)) && ['you', 'chat', 'email', 'text', 'matter', 'apple', 'news'].includes(v.origin.kind) && (!Object.hasOwn(v.origin, 'ref') || v.origin.ref === null || this.text(v.origin.ref, 2000));
        if (key === 'lifecycle') return this.exact(v, ['state', 'doneAt']) && ['open', 'done', 'dropped'].includes(v.state) &&
            (v.state === 'open' ? v.doneAt === null : this.text(v.doneAt, 64, true));
        if (key === 'goal') {
            if (!this.exact(v, ['domain', 'aim']) || ![null, 'fitness', 'health', 'money', 'parenting', 'learning'].includes(v.domain)) return false;
            if (v.aim === null) return true;
            const a = v.aim;
            return this.object(a) && Object.keys(a).every(k => ['measure', 'target', 'unit', 'dir', 'from'].includes(k)) && this.measure({ name: a.measure, value: a.target, unit: a.unit }) && ['up', 'down'].includes(a.dir) &&
                (!Object.hasOwn(a, 'from') || this.exact(a.from, ['value', 'day']) && this.date(a.from.day) && this.measure({ name: a.measure, value: a.from.value, unit: a.unit }));
        }
        if (key !== 'schedule' || !this.exact(v, ['when', 'by', 'repeat', 'until', 'remind'])) return false;
        if (v.when !== null && (!this.exact(v.when, ['date', 'time', 'end']) || v.when.date !== null && !this.date(v.when.date) || !this.timePair({ time: v.when.time, end: v.when.end }))) return false;
        if (v.by !== null && !this.date(v.by) || v.until !== null && !this.date(v.until)) return false;
        if (!this.exact(v.repeat, ['rule', 'days']) || !['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly', 'custom'].includes(v.repeat.rule) || !this.list(v.repeat.days, 6)) return false;
        if (['weekly', 'custom'].includes(v.repeat.rule) ? !v.repeat.days.length : v.repeat.days.length) return false;
        if (v.until !== null && (v.repeat.rule === 'none' || v.when?.date && v.until < v.when.date)) return false;
        return v.remind === null || this.exact(v.remind, ['minutesBefore', 'daysBefore']) &&
            (v.remind.minutesBefore === null || Number.isFinite(v.remind.minutesBefore) && v.remind.minutesBefore >= 0 && v.remind.minutesBefore <= 10080) && this.list(v.remind.daysBefore, 60);
    },
    dayID(id, date) { return `${id.length}:${id}:${date}`; },
    equal(a, b) {
        const stable = x => JSON.stringify(x, (_, v) => this.object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
        return stable(a) === stable(b);
    },
    emptyDay(c, date) { return { commitmentId: c, date, mark: null, log: [], moved: null }; },
    cleared(r) { return r.type === 'commitment-day' && this.equal(r.fields.day, this.emptyDay(r.fields.day.commitmentId, r.fields.day.date)); },
    records(blob) {
        if (!this.object(blob) || !Array.isArray(blob.items) || Object.keys(blob).some(k => !['items', 'ledger', 'tombstones'].includes(k))) throw Error('Invalid commitment snapshot.');
        if (blob.ledger != null && !Array.isArray(blob.ledger) || blob.tombstones != null && (!this.object(blob.tombstones) || Object.keys(blob.tombstones).length)) throw Error('Commitment deletion history needs migration before sync.');
        const out = new Map(), byID = new Map(), allowed = ['id', 'title', 'note', 'parent', 'outcome', 'when', 'by', 'repeat', 'until', 'remind', 'waitingOn', 'state', 'doneAt', 'history', 'log', 'moved', 'origin', 'shape', 'domain', 'aim', 'createdAt', 'updatedAt', 'read', 'tags', 'timer', 'attached', 'legacy', 'sourceSnapshot', 'privacySources', 'kind'];
        for (const c of blob.items) {
            if (!this.object(c) || !this.id(c.id) || byID.has(c.id)) throw Error('Commitment identity needs migration before sync.');
            if (Object.keys(c).some(k => !allowed.includes(k)) || ['tags', 'attached', 'privacySources'].some(k => c[k] != null && (!Array.isArray(c[k]) || c[k].length)) ||
                ['timer', 'sourceSnapshot', 'kind'].some(k => c[k] != null) || c.legacy != null && (!this.object(c.legacy) || Object.keys(c.legacy).length)) throw Error('Commitment details need migration before sync.');
            const fields = { title: c.title, note: c.note, outcome: c.outcome ?? null, parent: c.parent ?? null, waitingOn: c.waitingOn ?? null,
                created: { at: c.createdAt, origin: c.origin, shape: c.shape ?? null }, lifecycle: { state: c.state, doneAt: c.doneAt ?? null },
                schedule: { when: c.when ?? null, by: c.by ?? null, repeat: c.repeat, until: c.until ?? null, remind: c.remind ?? null }, goal: { domain: c.domain ?? null, aim: c.aim ?? null } };
            if (Object.entries(fields).some(([k, v]) => !this.validField('commitment', k, v))) throw Error('Invalid commitment wire fields.');
            out.set('commitment/' + c.id, { type: 'commitment', id: c.id, fields }); byID.set(c.id, c);
            const maps = ['history', 'log', 'moved'].map(k => c[k] ?? {});
            if (maps.some(m => !this.object(m))) throw Error('Invalid commitment day history.');
            for (const date of new Set(maps.flatMap(m => Object.keys(m)))) {
                const day = { commitmentId: c.id, date, mark: Object.hasOwn(maps[0], date) ? maps[0][date] : null, log: maps[1][date] ?? [], moved: maps[2][date] ?? null };
                const id = this.dayID(c.id, date);
                if (!this.id(id) || !this.validField('commitment-day', 'day', day)) throw Error('Invalid commitment day wire fields.');
                // Historical days remain even if the series was later changed.
                if (!this.cleared({ type: 'commitment-day', fields: { day } })) out.set('commitment-day/' + id, { type: 'commitment-day', id, fields: { day } });
            }
        }
        for (const c of byID.values()) {
            const seen = new Set([c.id]); let p = c.parent;
            while (p) {
                if (!byID.has(p) || seen.has(p)) throw Error('Commitment parent needs review before sync.');
                seen.add(p); p = byID.get(p).parent;
            }
        }
        return out;
    },
    plan(before, after, materialized = []) {
        const old = this.records(before), next = this.records(after), mutations = [], current = new Map(materialized.map(r => [r.type + '/' + r.id, r]));
        const matches = (r, fields) => r && !r.deleted && this.equal(Object.keys(r.fields).sort(), Object.keys(fields).sort()) && Object.entries(fields).every(([k, v]) => r.fields[k]?.versions.length === 1 && this.equal(r.fields[k].value, v));
        for (const [key, r] of old) {
            if (!matches(current.get(key), r.fields)) throw Error('Commitments need bootstrap or conflict review before saving.');
        }
        // Inbound additions and cleared days are part of the observed baseline too.
        for (const [key, r] of current) {
            if (old.has(key)) continue;
            const day = r.fields?.day?.value;
            if (r.type !== 'commitment-day' || !this.validField(r.type, 'day', day) || !old.has('commitment/' + day.commitmentId) || !matches(r, { day: this.emptyDay(day.commitmentId, day.date) })) throw Error('Commitments need bootstrap or conflict review before saving.');
        }
        for (const [key, r] of next) {
            const previous = old.get(key), existing = current.get(key);
            if (!previous && existing && !(r.type === 'commitment-day' && matches(existing, { day: this.emptyDay(r.fields.day.commitmentId, r.fields.day.date) }))) throw Error('Commitment id collision needs review.');
            if (previous && r.type === 'commitment' && !this.equal(previous.fields.created, r.fields.created)) throw Error('Commitment creation identity is immutable.');
            const fields = Object.fromEntries(Object.entries(r.fields).filter(([k, v]) => !previous || !this.equal(previous.fields[k], v)));
            if (Object.keys(fields).length) mutations.push({ type: r.type, id: r.id, mutation: { kind: 'edit', fields } });
        }
        for (const [key, r] of old) if (!next.has(key)) {
            if (r.type === 'commitment') throw Error('Missing commitment history; deletion needs migration before sync.');
            mutations.push({ type: r.type, id: r.id, mutation: { kind: 'edit', fields: { day: this.emptyDay(r.fields.day.commitmentId, r.fields.day.date) } } });
        }
        if (mutations.length > 256) throw Error('Commitment save requires a paged migration.');
        return { mutations, value: after };
    },
    project(records) {
        const items = [], days = [], byID = new Map(), issues = new Set();
        for (const r of records.filter(r => r.type === 'commitment')) {
            const value = k => r.fields?.[k]?.value;
            const required = ['title', 'note', 'outcome', 'parent', 'waitingOn', 'created', 'lifecycle', 'schedule', 'goal'];
            const conflicts = Object.fromEntries(Object.entries(r.fields || {}).filter(([, v]) => v.versions.length !== 1));
            const incomplete = required.some(k => !r.fields?.[k]);
            const c = { id: r.id, title: value('title'), note: value('note'), outcome: value('outcome'), parent: value('parent'), waitingOn: value('waitingOn'),
                createdAt: value('created')?.at, origin: value('created')?.origin, shape: value('created')?.shape,
                ...value('schedule'), ...value('lifecycle'), ...value('goal'), history: {}, log: {}, moved: {},
                deleted: r.deleted, incomplete, needsReview: incomplete || r.deleted || Object.keys(conflicts).length > 0, syncConflicts: conflicts, syncIssues: [] };
            items.push(c); byID.set(c.id, c);
        }
        const flag = (c, why) => { if (c) { c.needsReview = true; if (!c.syncIssues.includes(why)) c.syncIssues.push(why); } };
        for (const c of items) {
            const seen = new Set([c.id]); let p = c.parent;
            while (p) {
                if (!byID.has(p) || byID.get(p).deleted) { flag(c, 'missing-parent'); break; }
                if (seen.has(p)) { flag(c, 'parent-cycle'); break; }
                seen.add(p); p = byID.get(p).parent;
            }
        }
        for (const r of records.filter(r => r.type === 'commitment-day')) {
            const register = r.fields?.day, v = register?.value, c = byID.get(v?.commitmentId);
            const needsReview = r.deleted || !v || register.versions.length !== 1 || !c || c.needsReview;
            days.push({ id: r.id, versions: register?.versions || [], missingTarget: !c, needsReview });
            if (needsReview) { issues.add(r.id); flag(c, 'day-needs-review'); }
            if (!c || !v) continue;
            // Display values only. Every alternative stays alongside the item.
            if (v.mark !== null) c.history[v.date] = v.mark;
            if (v.log.length) c.log[v.date] = v.log;
            if (v.moved !== null) c.moved[v.date] = v.moved;
        }
        for (const c of items) if (c.needsReview) issues.add(c.id);
        return { items, days, issues: [...issues].sort() };
    }
});
if (typeof module !== 'undefined' && module.exports) module.exports = CommitmentSync;
