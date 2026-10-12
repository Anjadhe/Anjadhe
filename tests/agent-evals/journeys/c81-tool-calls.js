/**
 * C8.1 regression net — truncation-aware tool calls (findings 13/18/19/27).
 * Deterministic: exercises the AgentTools seam directly, no model.
 */
module.exports = [
  {
    id: 'c81-create-note-empty-args',
    name: 'create_note refuses empty args (the {} truncation fallback)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const before = ((StorageManager.get('notes')?.notes) || []).length;
        const r = await AgentTools.execute('create_note', {});
        const after = ((StorageManager.get('notes')?.notes) || []).length;
        const pass = !!r.error && /cut off/.test(r.error) && after === before;
        return { pass, detail: r.error || 'created an empty note' };
      });
    }
  }
];
