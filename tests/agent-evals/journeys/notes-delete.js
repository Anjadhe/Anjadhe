/**
 * delete_note (2026-08-08 — it sat in the untrusted blocklist since day
 * one but was never implemented; the assistant couldn't clean up a note
 * it created by mistake). Pinned:
 *  - deletes by exact title / id, WITH a tombstone (notes are record-
 *    merged; an untombstoned delete resurrects on sync).
 *  - ambiguous searches refuse with candidates.
 *  - armed routines refuse, pointing at delete_routine.
 *  - consent: /^delete_/ makes PermissionManager ask; untrusted turns
 *    block it entirely.
 */
module.exports = [
  {
    id: 'notes-delete-tool',
    name: 'delete_note deletes with a tombstone; ambiguity and routines refuse',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const mk = (title) => AgentTools.handlers.create_note({ title, content: 'body of ' + title });
        const a = mk('Eval Delete Me');
        mk('Eval Twin'); mk('Eval Twin');

        // Exact-title delete + tombstone.
        const del = AgentTools.handlers.delete_note({ search: 'Eval Delete Me' });
        const blob = StorageManager.get('notes') || {};
        const gone = !(blob.notes || []).some(n => n.title === 'Eval Delete Me');
        const tombstoned = !!(blob.tombstones && blob.tombstones[del.deleted && del.deleted.id]);

        // Ambiguity refuses with candidates.
        const ambig = AgentTools.handlers.delete_note({ search: 'Eval Twin' });
        const ambigOk = !!ambig.error && Array.isArray(ambig.candidates) && ambig.candidates.length === 2;

        // An armed routine refuses toward delete_routine.
        const routine = NotePrompts.create({ title: 'Eval Routine Note', body: 'x', config: {
            offline: true, runMode: 'digest', interval: 'daily',
            trigger: { type: 'time', interval: 'daily' }, web: false, useContext: false
        }});
        const refuse = AgentTools.handlers.delete_note({ id: routine.id });
        const refuseOk = !!refuse.error && /delete_routine/.test(refuse.error);
        NotePrompts.remove(routine.id);

        // Consent + injection posture.
        const asks = PermissionManager.ASK_TOOLS.has('delete_note') || /^delete_/.test('delete_note');
        const blocked = AgentService.UNTRUSTED_BLOCKED_TOOLS.has('delete_note');

        const pass = del.success && gone && tombstoned && ambigOk && refuseOk && asks && blocked;
        return { pass, detail: JSON.stringify({ del, gone, tombstoned, ambigOk, refuseOk, asks, blocked }) };
      });
    }
  }
];
