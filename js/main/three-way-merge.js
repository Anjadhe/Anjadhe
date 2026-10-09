/**
 * three-way-merge.js — merging a phone edit into the Mac's copy (2026-10-02).
 *
 * The Mac is the one truth; the phone edits a copy of some version of it.
 * When both changed the same blob, a whole-blob "newer wins" threw one side
 * away: a phone check-off replaced every task edit made on the Mac since, or a
 * Mac edit replaced the phone's. With the version the phone's edit STARTED
 * FROM (the base), each side's change is visible and both can be kept:
 *
 *   M1 Unchanged on one side → the other side's version, exactly.
 *   M2 Objects merge key by key; arrays of records (objects with an `id`)
 *      merge record by record, by id, then field by field.
 *   M3 A record one side deleted stays deleted unless the OTHER side changed
 *      it since the base — an edit is never thrown away for a delete.
 *   M4 Both sides changed the same field (or a non-record value): the newer
 *      record wins when both carry `updatedAt`/`modifiedAt`, else the phone's
 *      (it is the person's latest act, carried here by this upload).
 *   M5 No base (the phone could not say, or the Mac no longer holds that
 *      version): nothing the Mac holds is deleted, the phone's version of a
 *      record both hold wins (M4's rule), and a record only the PHONE holds
 *      is kept only if the phone touched it after its base stamp (`since`) —
 *      otherwise it is one the Mac deleted, and bringing it back is the
 *      ghost-task bug this module exists to end.
 *
 * Pure: no I/O, no clock. Inputs are never mutated.
 */

const ABSENT = undefined;

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isRecordArray(v) { return Array.isArray(v) && v.every(r => isObj(r) && r.id != null); }
function same(a, b) {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}
function stampOf(r) { return isObj(r) ? String(r.updatedAt || r.modifiedAt || '') : ''; }
function touchedOf(r) { return isObj(r) ? String(r.updatedAt || r.modifiedAt || r.createdAt || '') : ''; }

/** M4: which side wins a real conflict — decided at the RECORD (its stamps),
 *  then carried down to the record's fields as `prefer`. */
function preferOf(mine, theirs, inherited) {
    const m = stampOf(mine), t = stampOf(theirs);
    if (m && t) return m > t ? 'mine' : 'theirs';
    return inherited || 'theirs';
}
function pick(mine, theirs, prefer) {
    return preferOf(mine, theirs, prefer) === 'mine' ? mine : theirs;
}

function merge(base, mine, theirs, prefer) {
    if (same(theirs, base)) return mine;          // M1: only the Mac changed it
    if (same(mine, base)) return theirs;          // M1: only the phone changed it
    if (same(mine, theirs)) return mine;
    if (isRecordArray(mine) && isRecordArray(theirs) && (base === ABSENT || isRecordArray(base))) {
        return mergeRecords(base || [], mine, theirs, prefer);
    }
    if (isObj(mine) && isObj(theirs) && (base === ABSENT || isObj(base))) {
        const b = base || {};
        const p = preferOf(mine, theirs, prefer);
        const out = {};
        const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
        for (const k of keys) {
            const v = mergeSlot(k in b ? b[k] : ABSENT, k in mine ? mine[k] : ABSENT, k in theirs ? theirs[k] : ABSENT, p);
            if (v !== ABSENT) out[k] = v;
        }
        return out;
    }
    return pick(mine, theirs, prefer);            // M4
}

/** One slot that may be absent on any side (a key, or a record by id). */
function mergeSlot(b, m, t, prefer) {
    if (m === ABSENT && t === ABSENT) return ABSENT;
    if (b === ABSENT) {
        if (m === ABSENT) return t;               // added by the phone
        if (t === ABSENT) return m;               // added by the Mac
        return merge(ABSENT, m, t, prefer);       // added on both
    }
    if (m === ABSENT) return same(t, b) ? ABSENT : t;   // M3: Mac deleted; phone edited → keep
    if (t === ABSENT) return same(m, b) ? ABSENT : m;   // M3: phone deleted; Mac edited → keep
    return merge(b, m, t, prefer);
}

function mergeRecords(base, mine, theirs, prefer) {
    const byId = (arr) => new Map(arr.map(r => [String(r.id), r]));
    const B = byId(base), M = byId(mine), T = byId(theirs);
    const order = [...M.keys()];
    for (const id of T.keys()) if (!M.has(id)) order.push(id);
    const out = [];
    for (const id of order) {
        const v = mergeSlot(B.has(id) ? B.get(id) : ABSENT, M.has(id) ? M.get(id) : ABSENT, T.has(id) ? T.get(id) : ABSENT, prefer);
        if (v !== ABSENT) out.push(v);
    }
    return out;
}

/** M5: no base — keep everything from both sides, never delete. */
function union(mine, theirs, since, prefer) {
    if (same(mine, theirs)) return mine;
    if (isRecordArray(mine) && isRecordArray(theirs)) {
        const T = new Map(theirs.map(r => [String(r.id), r]));
        const out = mine.map(r => (T.has(String(r.id)) ? union(r, T.get(String(r.id)), since, prefer) : r));
        const seen = new Set(mine.map(r => String(r.id)));
        for (const r of theirs) {
            if (seen.has(String(r.id))) continue;
            const touched = touchedOf(r);
            if (!since || !touched || touched > since) out.push(r);
        }
        return out;
    }
    if (isObj(mine) && isObj(theirs)) {
        const p = preferOf(mine, theirs, prefer);
        const out = { ...mine };
        for (const k of Object.keys(theirs)) out[k] = k in mine ? union(mine[k], theirs[k], since, p) : theirs[k];
        return out;
    }
    return pick(mine, theirs, prefer);
}

/**
 * Merge a phone edit (`theirs`) into the Mac's current value (`mine`), given
 * the version the edit started from (`base`, or undefined when unknown).
 */
function mergePhoneEdit(base, mine, theirs, { haveBase = base !== ABSENT, since = '' } = {}) {
    if (mine === ABSENT || mine === null) return theirs;
    if (!haveBase) return union(mine, theirs, since);
    return merge(base, mine, theirs);
}

module.exports = { mergePhoneEdit, merge, union };
