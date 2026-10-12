'use strict';
// A storage adapter for the shared desktop rules, not another set of rules.
// Preparation touches a private draft only. The host must atomically compare
// the entire read set and commit changes + receipt after explicit approval.
const RecordTransaction = Object.freeze({
    keys: ['commitments', 'matters', 'senders', 'record-receipts'],
    prepare(source, command) {
        const clone = value => JSON.parse(JSON.stringify(value));
        const object = value => value && typeof value === 'object' && !Array.isArray(value);
        const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
        const safeId = id => typeof id === 'string' && id.length > 0 && id.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(id);
        const fail = error => ({ ok: false, error, changes: {} });
        if (!object(source) || !object(command) || !safeId(command.id)) return fail('Invalid action.');
        const blobs = clone(source);
        for (const key of this.keys) {
            if (own(blobs, key) && !object(blobs[key])) return fail('Saved records need recovery before editing.');
            if (!own(blobs, key)) blobs[key] = {};
        }
        const receipts = blobs['record-receipts'];
        if (receipts.items != null && !Array.isArray(receipts.items)) return fail('Saved receipts need recovery before editing.');
        receipts.items = receipts.items || [];
        const previous = receipts.items.find(r => r.id === command.id);
        if (previous) return { ok: true, replay: true, receipt: previous, changes: {} };
        const cb = blobs.commitments, sb = blobs.senders, mb = blobs.matters;
        if ((cb.items != null && !Array.isArray(cb.items)) || (cb.ledger != null && !Array.isArray(cb.ledger))) return fail('Saved commitments need recovery before editing.');
        for (const [blob, keys] of [[cb, ['tombstones']], [sb, ['senders', 'place', 'aliases']], [mb, ['matters']]]) {
            for (const key of keys) {
                if (blob[key] != null && !object(blob[key])) return fail('Saved records need recovery before editing.');
                blob[key] = Object.assign(Object.create(null), blob[key] || {});
            }
        }
        const items = Object.create(null);
        for (const c of cb.items || []) {
            if (!object(c) || !safeId(c.id) || own(items, c.id)) return fail('Saved commitments need recovery before editing.');
            items[c.id] = c;
        }
        const data = { items, ledger: cb.ledger || [], tombstones: cb.tombstones };
        const touched = new Set();
        const commitments = Object.assign({}, CommitmentCalendar, CommitmentRecords, {
            _measureSources: [], _load: () => data, _save: () => touched.add('commitments'), _afterWrite: () => {}
        });
        const senders = Object.assign({}, SenderMembership, SenderRecords, {
            _load: () => sb, _save: () => touched.add('senders')
        });
        const available = c => c && !(c.privacySources || []).includes('slack') && c.origin?.kind !== 'plan';
        const args = object(command.args) ? command.args : {};
        const target = args.target;
        let result, label, record, threadKey, previousRecord;
        const fields = args.fields;
        const place = key => {
            if (!args.sender) return true;
            if (!safeId(args.sender) || !own(sb.senders, senders.resolve(sb, args.sender)) || sb.senders[senders.resolve(sb, args.sender)].state === 'archived') return false;
            if (!senders.move(key, args.sender)) return false;
            threadKey = senders.resolve(sb, args.sender);
            return true;
        };
        // Closed capability list: never dispatch a caller-provided method name.
        switch (command.operation) {
        case 'commitment.create':
        case 'commitment.change': {
            const creating = command.operation === 'commitment.create';
            if (!creating && (!safeId(target) || !available(items[target]))) return fail('This commitment is not available.');
            if (!object(fields)) return fail('A commitment needs checked fields.');
            const checked = commitments.vetFields(fields, items, creating ? null : target);
            const unknown = Object.keys(fields).filter(k => !own(checked.fields, k) && !checked.dropped.includes(k));
            if (checked.dropped.length || unknown.length) return fail('Some fields are invalid. Review the action before saving.');
            if (checked.fields.parent && !available(items[checked.fields.parent])) return fail('This parent is not available.');
            const by = command.actor === 'assistant' ? 'assistant' : 'you';
            result = creating ? commitments.create(checked.fields, { by }) : commitments.change(target, checked.fields, { by });
            label = creating ? 'Added commitment' : 'Updated commitment';
            record = items[result.id];
            if (result.ok && !place(`task:${result.id}`)) return fail('This thread is no longer available.');
            break;
        }
        case 'commitment.report':
            if (!safeId(target) || !available(items[target]) || !object(args.report)) return fail('This report is not available.');
            result = commitments.report(target, args.report, { by: 'assistant' });
            if (result.refused?.length) return fail('Some figures could not be verified. Nothing was saved.');
            record = items[target]; label = 'Saved report'; break;
        case 'commitment.resolve':
            if (!safeId(target) || !available(items[target]) || !['done', 'dropped'].includes(args.how)) return fail('This change is not available.');
            result = commitments.resolve(target, args.how, { by: 'assistant', why: args.quote || '' });
            record = items[target]; label = args.how === 'done' ? 'Marked done' : 'Dropped commitment'; break;
        case 'commitment.done':
            if (!safeId(target) || !available(items[target]) || typeof args.done !== 'boolean' || (args.day && !commitments.day(args.day))) return fail('Invalid completion change.');
            result = commitments.setDone(target, args.done, { date: args.day || null });
            record = items[target]; label = args.done ? 'Marked done' : 'Reopened commitment'; break;
        case 'commitment.undo': {
            const entry = data.ledger.find(e => e.id === target);
            if (!entry || !available(items[entry.target] || entry.before)) return fail('This change is not available to undo.');
            previousRecord = items[entry.target] || entry.before;
            result = commitments.undo(target); record = items[entry.target]; label = 'Undid commitment change'; break;
        }
        case 'sender.create':
            record = senders.create(args.name, args.allGood); result = { ok: !!record, id: record?.id };
            label = 'Created thread'; threadKey = record?.id; break;
        case 'sender.rename':
        case 'sender.archive': {
            if (!safeId(target) || !own(sb.senders, senders.resolve(sb, target))) return fail('This thread is not available.');
            const edit = command.operation === 'sender.rename' ? senders.rename(target, args.name) : senders.archive(target);
            record = edit?.sender; result = { ok: !!record, id: record?.id };
            label = command.operation === 'sender.rename' ? 'Renamed thread' : 'Archived thread'; break;
        }
        case 'matter.file': {
            // Evidence is data, never a request to execute its instructions.
            // Filing is only a local record write. No sending, payment or task
            // execution is exposed by this adapter.
            if (!object(args.observation) || !safeId(args.observation.id) || !['chat', 'email'].includes(args.observation.source)) return fail('Invalid source.');
            const f = MatterRecords.observation(args.observation);
            if (Object.values(mb.matters).some(m => m.id === `matter:${f.id}` || (m.sources || []).some(s => s.id === f.id))) return fail('This source has already been filed.');
            const candidates = MatterRecords.candidates(f, Object.values(mb.matters).filter(available));
            const checked = MatterRecords.vet(args.judgment, f, candidates);
            if (!checked || checked.about === 'none') return fail('There is no checked matter to file.');
            record = MatterRecords.apply(mb.matters, checked, f);
            if (!record) return fail('Could not file this matter.');
            touched.add('matters');
            if (!place(record.id)) return fail('This thread is no longer available.');
            result = { ok: true, id: record.id }; label = 'Filed matter'; break;
        }
        default: return fail('This action is not supported.');
        }
        if (!result?.ok) return fail(result?.error || 'Nothing was changed.');
        if (!touched.size) return { ok: true, unchanged: true, changes: {} };
        if (touched.has('commitments')) {
            cb.items = Object.values(data.items); cb.ledger = data.ledger; cb.tombstones = data.tombstones;
        }
        const item = record || previousRecord;
        if (!threadKey && command.operation.startsWith('commitment.') && item) {
            const key = `task:${item.id}`;
            threadKey = SenderMembership.senderOfIn(sb, key, {
                matterOf: id => mb.matters[id],
                folderOfTask: id => Object.values(mb.matters).find(m => (m.tasks || []).includes(id) || m.next?.taskId === id),
                commitment: id => items[id] || (item.id === id ? item : null)
            }) || (SenderMembership.isToDo(item, [...Object.values(items), item]) ? 'sender:reminders' : key);
        }
        const receipt = { id: command.id, operation: command.operation, at: new Date().toISOString(), label,
            target: result.id || target, ledgerId: result.ledgerId || null, title: item?.title || item?.name || '',
            threadKey: threadKey || null };
        receipts.items.push(receipt);
        // Receipt ids are durable idempotency keys. Do not prune without a
        // coordinated retention policy: an old delivery must stay a no-op.
        touched.add('record-receipts');
        return { ok: true, receipt, record: record || null,
            changes: Object.fromEntries([...touched].map(key => [key, blobs[key]])) };
    }
});
