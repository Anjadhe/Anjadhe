'use strict';
// Typed thread identity and placement adapter. Deliberately opt-in: facts,
// folds, unread history and source records need their own migration contracts.
const SenderSync = Object.freeze({
    id: value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[^A-Za-z0-9._:-]/.test(value),
    validField(type, key, value) {
        const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
        const recordID = this.id;
        if (type === 'sender') {
            if (key === 'name') return typeof value === 'string' && value.length > 0 && value.length <= 40;
            if (key === 'allGood') return typeof value === 'string' && value.length <= 200;
            if (key === 'confirmed') return typeof value === 'boolean';
            if (key === 'created') return plain(value) && Object.keys(value).length === 2 && ['you', 'nenva'].includes(value.by) && typeof value.at === 'string' && value.at.length > 0 && value.at.length <= 64;
            return key === 'lifecycle' && plain(value) && Object.keys(value).length === 2 &&
                (value.state === 'active' ? value.archivedAt === null : value.state === 'archived' && typeof value.archivedAt === 'string' && value.archivedAt.length > 0 && value.archivedAt.length <= 64);
        }
        if (type === 'sender-placement') return key === 'placement' && (value === null || plain(value) && Object.keys(value).length === 3 &&
            recordID(value.sender) && ['you', 'nenva'].includes(value.by) && typeof value.at === 'string' && value.at.length > 0 && value.at.length <= 64);
        return false;
    },
    equal(a, b) {
        const stable = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
        return stable(a) === stable(b);
    },
    records(blob) {
        const object = v => v && typeof v === 'object' && !Array.isArray(v);
        if (!object(blob) || !object(blob.senders) || !object(blob.place)) throw Error('Invalid sender snapshot.');
        // Local scheduling caches may remain local. Everything else must have
        // a wire contract before this adapter can claim a complete baseline.
        const localKeys = ['version', 'senders', 'place', 'tries'];
        for (const [key, value] of Object.entries(blob)) {
            if (!localKeys.includes(key) && value != null && (!object(value) || Object.keys(value).length)) throw Error('Sender history needs migration before sync.');
        }
        const records = new Map();
        for (const [id, s] of Object.entries(blob.senders)) {
            if (!this.id(id) || !object(s) || s.id !== id) throw Error('Sender identity needs migration before sync.');
            const keys = ['id', 'name', 'allGood', 'confirmed', 'state', 'archivedAt', 'by', 'createdAt', 'updatedAt'];
            if (Object.keys(s).some(k => !keys.includes(k))) throw Error('Sender details need migration before sync.');
            if (s.state === 'active' && s.archivedAt != null) throw Error('Active sender has an archive date.');
            records.set('sender/' + id, { type: 'sender', id, fields: {
                name: s.name, allGood: s.allGood, confirmed: s.confirmed,
                lifecycle: { state: s.state, archivedAt: s.archivedAt ?? null }, created: { at: s.createdAt, by: s.by }
            } });
        }
        for (const [id, placement] of Object.entries(blob.place)) {
            if (!this.id(id) || placement !== null && (!object(placement) || Object.keys(placement).sort().join(',') !== 'at,by,sender' || !Object.hasOwn(blob.senders, placement.sender))) throw Error('Placement target needs migration before sync.');
            records.set('sender-placement/' + id, { type: 'sender-placement', id, fields: { placement } });
        }
        for (const r of records.values()) if (Object.entries(r.fields).some(([k, v]) => !this.validField(r.type, k, v))) throw Error('Invalid sender wire fields.');
        return records;
    },
    plan(before, after, materialized = []) {
        const old = this.records(before), next = this.records(after), mutations = [];
        const current = new Map(materialized.map(r => [r.type + '/' + r.id, r]));
        // Check the entire baseline, not only edited fields. A stale projection
        // must not overwrite peer work by claiming it in its causal frontier.
        for (const [key, previous] of old) {
            const r = current.get(key);
            if (!r || r.deleted || Object.entries(previous.fields).some(([k, v]) => r.fields?.[k]?.versions?.length !== 1 || !this.equal(v, r.fields[k].value))) throw Error('Sender sync needs bootstrap or conflict review before editing.');
        }
        for (const [key, record] of next) {
            const previous = old.get(key);
            if (!previous && current.has(key)) throw Error('Sender identity collision needs review.');
            if (previous?.fields.created && !this.equal(previous.fields.created, record.fields.created)) throw Error('Sender creation identity cannot change.');
            if (previous?.fields.placement?.by === 'you' && record.fields.placement?.by === 'nenva') throw Error('Automatic placement cannot replace a personal choice.');
            const fields = Object.fromEntries(Object.entries(record.fields).filter(([k, v]) => !this.equal(previous?.fields[k], v)));
            if (Object.keys(fields).length) mutations.push({ type: record.type, id: record.id, mutation: { kind: 'edit', fields } });
        }
        for (const key of old.keys()) if (!next.has(key)) throw Error('Missing sender history is not deletion; archive or explicitly clear the placement.');
        if (mutations.length > 256) throw Error('Sender bootstrap needs a paged migration.');
        return { mutations, value: after };
    },
    project(records) {
        const senders = Object.create(null), place = Object.create(null), placements = [], issues = [];
        for (const r of records.filter(r => r.type === 'sender')) {
            const required = ['name', 'allGood', 'confirmed', 'lifecycle', 'created'];
            const conflicts = Object.fromEntries(Object.entries(r.fields || {}).filter(([, v]) => v.versions.length !== 1));
            const incomplete = required.some(k => !r.fields?.[k]);
            const value = k => r.fields?.[k]?.value;
            senders[r.id] = { id: r.id, name: value('name'), allGood: value('allGood'), confirmed: value('confirmed'),
                state: value('lifecycle')?.state, archivedAt: value('lifecycle')?.archivedAt,
                createdAt: value('created')?.at, by: value('created')?.by,
                needsReview: incomplete || r.deleted || Object.keys(conflicts).length > 0, incomplete, syncConflicts: conflicts };
        }
        for (const r of records.filter(r => r.type === 'sender-placement')) {
            const register = r.fields?.placement;
            const versions = register?.versions || [];
            const missingTargets = [...new Set(versions.map(v => v.value?.sender).filter(id => id && !senders[id]))];
            const needsReview = r.deleted || versions.length !== 1 || missingTargets.length > 0 || versions.some(v => v.value && senders[v.value.sender]?.needsReview);
            // Never choose a home from the reducer's deterministic display
            // winner when placement conflicts. Keep all candidates for review.
            if (!needsReview) place[r.id] = register.value;
            placements.push({ key: r.id, versions, missingTargets, needsReview });
            if (needsReview) issues.push(r.id);
        }
        return { senders, place, placements, issues };
    }
});
if (typeof module !== 'undefined' && module.exports) module.exports = SenderSync;
