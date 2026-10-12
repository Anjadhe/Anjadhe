'use strict';
const Senders = require('../shared/sender-sync');

// Pure v2 merge reference. No storage, network, execution or clock access.
// R1 Same valid operation set yields the same state in any delivery order.
// R2 A dot (device, sequence) is immutable; differing reuse is rejected.
// R3 Only contiguous, dependency-complete supported operations advance receipts.
// R4 Concurrent field versions survive; deletion needs an observed Restore.
// R5 Tags remove observed additions; completion is scoped to an occurrence.
// Companion: AnjadheCore/RecordMerge.swift and fixtures/record-merge.
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const token = x => typeof x === 'string' && x.length >= 1 && x.length <= 80 && !/[^a-z0-9-]/.test(x);
const recordID = x => typeof x === 'string' && x.length >= 1 && x.length <= 160 && !/[^A-Za-z0-9._:-]/.test(x);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const stable = x => JSON.stringify(x, function (_, value) {
    return plain(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value;
});
const canonicalNumbers = value => typeof value === 'number' && value === 0 ? 0
    : Array.isArray(value) ? value.map(canonicalNumbers)
    : plain(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canonicalNumbers(v)])) : value;
const fail = () => { throw new Error('Invalid record operation'); };
const dot = o => `${o.deviceId}:${o.sequence}`;
const counterAt = (vector, writer) => Object.hasOwn(vector, writer) ? vector[writer] : 0;
const cmp = (a, b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : a.sequence - b.sequence;
const observes = (a, b) => counterAt(a.dependencies, b.deviceId) >= b.sequence;
const supports = o => o.schemaVersion === 1 && ['note', 'task', 'conversation', 'conversation-message', 'sender', 'sender-placement'].includes(o.recordType);
const textCompare = (a, b) => {
    const x = Array.from(a, c => c.codePointAt(0)), y = Array.from(b, c => c.codePointAt(0));
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
};
function calendarDate(value) {
    if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$(?![\s\S])/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function validField(type, key, value) {
    if (type === 'sender' || type === 'sender-placement') return Senders.validField(type, key, value);
    if (type === 'conversation') {
        if (key === 'title' || key === 'createdAt') return typeof value === 'string' && value.length <= 4000;
        if (key === 'thread') return value === null || recordID(value);
        return key === 'privacy' && plain(value) && Object.keys(value).length === 2 && typeof value.untrusted === 'boolean' && ['simple', 'full'].includes(value.contextMode);
    }
    if (type === 'conversation-message') return key === 'message' && plain(value) && Object.keys(value).length === 6 &&
        recordID(value.conversationId) && recordID(value.id) && (value.parentId === null || (recordID(value.parentId) && value.parentId !== value.id)) &&
        ['user', 'assistant'].includes(value.role) && typeof value.content === 'string' && value.content.length <= 100000 &&
        typeof value.timestamp === 'string' && value.timestamp.length <= 64;
    if (key === 'title' || (type === 'note' && key === 'content') || (type === 'task' && key === 'description')) return typeof value === 'string';
    if (type === 'note' && key === 'pinned') return typeof value === 'boolean';
    if (type !== 'task' || key !== 'schedule') return false;
    if (value === null) return true;
    if (!plain(value)) return false;
    const times = ['startTime', 'endTime'];
    const counts = ['dayOfWeek', 'notifyBefore'];
    const lists = ['repeatDays', 'reminderDaysBefore'];
    for (const [k, v] of Object.entries(value)) {
        if (times.includes(k)) { if (v !== null && !(typeof v === 'string' && (v === '' || /^([01]\d|2[0-3]):[0-5]\d$(?![\s\S])/.test(v)))) return false; }
        else if (k === 'scheduledDate') { if (v !== null && !calendarDate(v)) return false; }
        else if (k === 'repeat') { if (!['none', 'daily', 'weekdays', 'weekly', 'monthly', 'annually', 'custom'].includes(v)) return false; }
        else if (counts.includes(k)) { if (v !== null && (!integer(v) || (k === 'dayOfWeek' && v > 6))) return false; }
        else if (lists.includes(k)) { if (!Array.isArray(v) || v.some(n => !integer(n) || (k === 'repeatDays' && n > 6))) return false; }
        else return false;
    }
    return !(value.startTime && value.endTime && value.endTime < value.startTime);
}

function validate(o, datasetId, membershipEpoch) {
    if (!plain(o) || o.protocolVersion !== 2 || !integer(o.schemaVersion) || o.schemaVersion < 1 ||
        o.datasetId !== datasetId || o.membershipEpoch !== membershipEpoch || !token(o.deviceId) ||
        !integer(o.sequence) || o.sequence < 1 || !plain(o.dependencies) ||
        !token(o.recordType) || !recordID(o.recordId) || !plain(o.mutation)) fail();
    const keys = ['protocolVersion', 'schemaVersion', 'datasetId', 'membershipEpoch', 'deviceId', 'sequence', 'dependencies', 'recordType', 'recordId', 'mutation', 'modifiedAt'];
    if (Object.keys(o).some(k => !keys.includes(k)) || ('modifiedAt' in o && typeof o.modifiedAt !== 'string')) fail();
    for (const [writer, seq] of Object.entries(o.dependencies)) if (!token(writer) || !integer(seq)) fail();
    if (counterAt(o.dependencies, o.deviceId) !== o.sequence - 1) fail();
    if (!supports(o)) return;
    const m = o.mutation;
    if (!['edit', 'delete', 'restore'].includes(m.kind) || Object.keys(m).some(k => !['kind', 'fields', 'tagAdds', 'tagRemoves', 'completion'].includes(k))) fail();
    if ('fields' in m && (!plain(m.fields) || Object.entries(m.fields).some(([k, v]) => !validField(o.recordType, k, v)))) fail();
    if (['conversation', 'conversation-message', 'sender', 'sender-placement'].includes(o.recordType) && ['tagAdds', 'tagRemoves', 'completion'].some(k => k in m)) fail();
    // Senders are archived, not deleted; placements clear with a null register.
    if (['sender', 'sender-placement'].includes(o.recordType) && m.kind !== 'edit') fail();
    if (o.recordType === 'conversation-message' && m.fields?.message &&
        o.recordId !== `${m.fields.message.conversationId.length}:${m.fields.message.conversationId}:${m.fields.message.id}`) fail();
    for (const k of ['tagAdds', 'tagRemoves']) if (k in m && (!Array.isArray(m[k]) || m[k].some(s => typeof s !== 'string' || !s.length || s.length > 512))) fail();
    if ('completion' in m && (o.recordType !== 'task' || !plain(m.completion) ||
        !recordID(m.completion.occurrence) || typeof m.completion.done !== 'boolean' || Object.keys(m.completion).length !== 2)) fail();
    const changes = Object.keys(m.fields || {}).length + (m.tagAdds || []).length + (m.tagRemoves || []).length + ('completion' in m ? 1 : 0);
    if ((m.kind === 'delete' && changes !== 0) || (m.kind === 'edit' && changes === 0)) fail();
}

function validateReady(o, lookup, observedDelete) {
    // A vector must include the transitive dependencies of every dot it observes.
    for (const [w, s] of Object.entries(o.dependencies)) if (s > 0) {
        const parent = lookup(w, s);
        if (!parent || Object.entries(parent.dependencies).some(([p, n]) => counterAt(o.dependencies, p) < n)) fail();
    }
    if (o.mutation.kind === 'restore' && !observedDelete()) fail();
    for (const removed of o.mutation.tagRemoves || []) {
        const match = /^([a-z0-9-]+):([1-9]\d*):([0-9]+)$(?![\s\S])/.exec(removed);
        if (!match) fail();
        const add = lookup(match[1], Number(match[2])), index = Number(match[3]);
        if (!add || !observes(o, add) || add.recordId !== o.recordId || add.recordType !== o.recordType ||
            !Number.isSafeInteger(index) || !(index in (add.mutation.tagAdds || [])) || String(index) !== match[3]) fail();
    }
}

function materialize(ops) {
    const fieldWrites = new Map(), completions = new Map(), additions = new Map(), removed = new Set();
    function add(map, key, o, value) {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ op: o, value });
    }
    for (const o of ops) {
        for (const [k, value] of Object.entries(o.mutation.fields || {})) add(fieldWrites, k, o, value);
        if (o.mutation.completion) add(completions, o.mutation.completion.occurrence, o, o.mutation.completion.done);
        (o.mutation.tagAdds || []).forEach((tag, index) => additions.set(`${dot(o)}:${index}`, tag.normalize('NFC')));
        (o.mutation.tagRemoves || []).forEach(id => removed.add(id));
    }
    function registers(map) {
        return Object.fromEntries([...map.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, values]) => {
            let heads = [];
            for (const write of values) {
                if (heads.some(head => observes(head.op, write.op))) continue;
                heads = heads.filter(head => !observes(write.op, head.op));
                heads.push(write);
            }
            heads.sort((a, b) => cmp(a.op, b.op));
            return [key, { value: heads[heads.length - 1].value, versions: heads.map(h => ({ operation: dot(h.op), value: h.value })) }];
        }));
    }
    const fields = registers(fieldWrites), completion = registers(completions);
    const deletes = ops.filter(d => d.mutation.kind === 'delete' && !ops.some(r => ['restore', 'delete'].includes(r.mutation.kind) && observes(r, d)));
    const deletionConflicts = ops.filter(o => o.mutation.kind !== 'delete' && deletes.some(d => !observes(d, o) && !observes(o, d))).sort(cmp).map(dot);
    const conflicts = map => Object.keys(map).filter(k => new Set(map[k].versions.map(v => stable(v.value))).size > 1);
    const tags = [...new Set([...additions].filter(([id]) => !removed.has(id)).map(([, tag]) => tag))].sort(textCompare);
    return { type: ops[0].recordType, id: ops[0].recordId, deleted: deletes.length > 0, fields, tags, completions: completion,
        conflicts: { fields: conflicts(fields), completions: conflicts(completion), deletion: deletionConflicts } };
}

function reduce(operations, datasetId, membershipEpoch = 1) {
    if (!token(datasetId) || !integer(membershipEpoch) || membershipEpoch < 1 || !Array.isArray(operations)) fail();
    const all = new Map();
    for (const raw of operations) {
        const o = canonicalNumbers(raw);
        validate(o, datasetId, membershipEpoch);
        const id = dot(o);
        if (all.has(id) && stable(all.get(id)) !== stable(o)) throw new Error('Operation identity reused with different content');
        all.set(id, o);
    }
    const remaining = [...all.values()].sort(cmp), applied = [], frontier = Object.create(null);
    let progress = true;
    while (progress) {
        progress = false;
        for (let i = 0; i < remaining.length;) {
            const o = remaining[i];
            if (!supports(o) || Object.entries(o.dependencies).some(([w, s]) => (frontier[w] || 0) < s)) { i++; continue; }
            const same = applied.filter(p => p.recordType === o.recordType && p.recordId === o.recordId);
            validateReady(o, (w, seq) => all.get(`${w}:${seq}`), () => same.some(p => p.mutation.kind === 'delete' && observes(o, p)));
            applied.push(o); frontier[o.deviceId] = o.sequence;
            remaining.splice(i, 1); progress = true;
        }
    }
    const groups = new Map();
    for (const o of applied) {
        const key = `${o.recordType}/${o.recordId}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(o);
    }
    const records = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, ops]) => {
        return materialize(ops);
    });
    return { frontier: { ...frontier }, applied: applied.sort(cmp).map(dot),
        pending: remaining.map(o => ({ operation: dot(o), reason: supports(o) ? 'dependencies' : 'unsupported-schema' })), records };
}

module.exports = { reduce, validate, stable, supports, validateReady, materialize, token, counterAt };
