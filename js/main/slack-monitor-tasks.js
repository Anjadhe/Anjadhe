'use strict';
const Commitments = require('../core/commitments');

/** Stage through the same commitment laws and ledger as Tasks. The caller
 * commits these changes with the insight and delivery receipt in one SQLite
 * transaction. No recurrence, parent goal or unrelated task is settled. */
function stageTasks(before, next, ids, stored, schedule, now = Date.now()) {
    const service = Object.create(Commitments);
    service._data = { items: Object.fromEntries((stored?.items || []).map(c => [c.id, structuredClone(c)])),
        ledger: structuredClone(stored?.ledger || []), tombstones: structuredClone(stored?.tombstones || {}) };
    service._save = () => {};
    const changed = new Set();
    for (const id of ids) {
        const m = next.matters[id], step = m?.next;
        if (!step || step.evidenceInvalidated || m.evidenceNeedsReview) continue;
        const previous = before.matters[id];
        const task = service.get(step.taskId);
        if (m.state !== 'open') {
            // Only the exact step already linked BEFORE this observation can
            // settle a task. A model cannot pick a new task and mark it done.
            if (!['done', 'cancelled'].includes(m.state) || previous?.state !== 'open'
                || m.sources?.at(-1)?.slack?.kind !== 'resolution'
                || !task || previous?.next?.taskId !== task.id || task.state !== 'open'
                || service.repeats(task) || service.shapeOf(task) !== 'task'
                || Object.values(service._data.items).some(c => c.parent === task.id)) continue;
            service.resolve(task.id, m.state === 'cancelled' ? 'dropped' : 'done',
                { by: 'assistant', why: 'Explicit resolution in the linked Slack conversation.' });
            changed.add(task.id);
        }
    }
    if (!changed.size) return null;
    const rows = structuredClone(schedule?.scheduleItems || []);
    for (const id of changed) {
        const task = service.toTask(service.get(id), service.today(now));
        const index = rows.findIndex(t => t.id === id);
        if (index < 0) rows.push(task); else rows[index] = task;
    }
    return { commitments: { ...stored, items: Object.values(service._data.items),
        ledger: service._data.ledger.slice(-Commitments.LEDGER_MAX), tombstones: service._data.tombstones },
        schedule: { ...schedule, scheduleItems: rows } };
}
module.exports = { stageTasks };
