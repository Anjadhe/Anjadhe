/**
 * C8.4 regression net — write ledger, pre-images, undo, post-conditions.
 */
module.exports = [
  {
    id: 'c84-scope-preimage-pills',
    name: 'a captured write records an entry, a pre-image, and a pill',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const id = WriteLedger.beginScope('turn', 'eval');
        const res = await WriteLedger.captureToolRun(id, () =>
          AgentTools.execute('create_note', { title: 'Ledger Eval', content: 'v1' }));
        WriteLedger.noteToolResult(id, 'create_note', { title: 'Ledger Eval' }, res);
        const scope = WriteLedger.getScope(id);
        const pills = WriteLedger.pillsForScope(id);
        const preview = WriteLedger.undoPreview(id);
        window.__c84ScopeId = id;
        const pass = scope.entries.length === 1 && ('notes' in scope.preImages)
          && pills?.length === 1 && pills[0].title === 'Ledger Eval' && preview?.keys === 1;
        return { pass, detail: JSON.stringify({ entries: scope.entries.length, pills, preview }) };
      });
    }
  },
  {
    id: 'c84-undo-restores',
    name: 'undo restores the key and retires the affordance',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const id = window.__c84ScopeId;
        const rep = await WriteLedger.undoScope(id);
        await NotesApp.loadNotes?.();
        const still = (NotesApp.notes || []).some(n => n.title === 'Ledger Eval');
        const preview = WriteLedger.undoPreview(id);
        const pass = rep.restoredKeys.includes('notes') && !still && preview === null;
        return { pass, detail: JSON.stringify({ restored: rep.restoredKeys, still }) };
      });
    }
  },
  {
    id: 'c84-conflict-skip',
    name: 'a key the user changed since is skipped, never clobbered',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const id = WriteLedger.beginScope('turn', 'conflict eval');
        const res = await WriteLedger.captureToolRun(id, () =>
          AgentTools.execute('create_note', { title: 'Conflict Eval', content: 'v1' }));
        WriteLedger.noteToolResult(id, 'create_note', { title: 'Conflict Eval' }, res);
        WriteLedger.endScope(id);
        const blob = StorageManager.get('notes');
        blob.notes.push({ id: 'user_eval_1', title: 'Users Own Note', content: 'mine', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        StorageManager.set('notes', blob);
        const rep = await WriteLedger.undoScope(id);
        const notes = (StorageManager.get('notes')?.notes) || [];
        const pass = rep.conflictKeys.includes('notes') && rep.restoredKeys.length === 0
          && notes.some(n => n.title === 'Conflict Eval') && notes.some(n => n.title === 'Users Own Note');
        return { pass, detail: JSON.stringify({ conflicts: rep.conflictKeys }) };
      });
    }
  },
  {
    id: 'c84-fs-preimage',
    name: 'fs_write pre-image restores; a brand-new file is trashed on undo',
    kind: 'det',
    async run({ page, docs }) {
      return await page.evaluate(async (dir) => {
        await window.electronAgentFS.write(dir + '/c84-orig.txt', 'ORIGINAL v1');
        const id = WriteLedger.beginScope('turn', 'fs eval');
        const w1 = await WriteLedger.captureToolRun(id, () =>
          AgentTools.execute('fs_write', { path: dir + '/c84-orig.txt', content: 'OVERWRITTEN v2' }));
        WriteLedger.noteToolResult(id, 'fs_write', { path: dir + '/c84-orig.txt' }, w1);
        const w2 = await WriteLedger.captureToolRun(id, () =>
          AgentTools.execute('fs_write', { path: dir + '/c84-new.txt', content: 'new file' }));
        WriteLedger.noteToolResult(id, 'fs_write', { path: dir + '/c84-new.txt' }, w2);
        const rep = await WriteLedger.undoScope(id);
        const back = await window.electronAgentFS.read(dir + '/c84-orig.txt');
        const gone = await window.electronAgentFS.read(dir + '/c84-new.txt');
        const pass = w1.fsUndo?.kind === 'restore' && w2.fsUndo?.kind === 'remove'
          && rep.restoredFiles.length === 2 && back.text === 'ORIGINAL v1' && !!gone.error;
        return { pass, detail: JSON.stringify({ kinds: [w1.fsUndo?.kind, w2.fsUndo?.kind], back: back.text, gone: !!gone.error }) };
      }, docs);
    }
  },
  {
    id: 'c84-external-irreversible',
    name: 'external actions are marked "cannot be undone from here"',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const id = WriteLedger.beginScope('turn', 'ext eval');
        WriteLedger.noteToolResult(id, 'send_email', { subject: 'Hi' }, { sent: true });
        const e = WriteLedger.getScope(id).entries[0];
        const preview = WriteLedger.undoPreview(id);
        const pass = e?.external === true && /cannot be undone/.test(e?.note || '') && preview === null;
        return { pass, detail: JSON.stringify(e) };
      });
    }
  },
  {
    id: 'c84-postconditions-override',
    name: 'mechanical checks decide verdicts; all-checked skips the model',
    kind: 'det',
    async run({ page, docs }) {
      return await page.evaluate(async (dir) => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_e_pc', goal: 'pc eval', conversationId: null,
          plan: [
            { step: 'a', tools: [], status: 'done', note: '', result: 'r', check: { kind: 'file_exists', arg: dir + '/statement.pdf' } },
            { step: 'b', tools: [], status: 'done', note: '', result: 'claimed', check: { kind: 'file_exists', arg: dir + '/never-written.txt' } }
          ],
          status: 'verifying', note: '', stepIndex: 2, retried: false, toolCalls: 2,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        let modelCalled = false;
        const origChat = TaskService._chat;
        TaskService._chat = async () => { modelCalled = true; return { message: { content: '' } }; };
        const verdicts = await TaskService._verify('task_e_pc');
        TaskService._chat = origChat;
        const pass = !modelCalled && verdicts?.[0]?.ok === true && verdicts?.[1]?.ok === false
          && /does not exist/.test(verdicts?.[1]?.issue || '');
        return { pass, detail: JSON.stringify({ modelCalled, verdicts }) };
      }, docs);
    }
  }
];
