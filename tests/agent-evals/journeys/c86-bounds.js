/**
 * C8.6 regression net — bounded autonomy: budgets, expiry, exclusions.
 */
module.exports = [
  {
    id: 'c86-budget-exhaustion',
    name: 'a 2/day budget allows twice then asks with the limit named',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        await PermissionManager.ready();
        await PermissionManager.grantAlways('trash_email');
        const id = PermissionManager.listGrants().find(g => g.tool === 'trash_email').id;
        await PermissionManager.setGrantBounds(id, { budget: 2 });
        const a = PermissionManager.resolve('trash_email', {});
        const b = PermissionManager.resolve('trash_email', {});
        const c = PermissionManager.resolve('trash_email', {});
        await PermissionManager.revoke(id);
        const pass = a.decision === 'allow' && b.decision === 'allow'
          && c.decision === 'ask' && c.budgetExhausted === true && /daily limit \(2\/day\)/.test(c.note || '');
        return { pass, detail: JSON.stringify({ a: a.decision, b: b.decision, c: c.decision, note: (c.note || '').slice(0, 60) }) };
      });
    }
  },
  {
    id: 'c86-expiry-lapses',
    name: 'an expired grant lapses to ask and leaves the list',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        await PermissionManager.grantAlways('create_calendar_event');
        const id = PermissionManager.listGrants().find(g => g.tool === 'create_calendar_event').id;
        const g = PermissionManager._grants.find(x => x.id === id);
        g.expiresAt = new Date(Date.now() - 1000).toISOString();
        await PermissionManager._save();
        const res = PermissionManager.resolve('create_calendar_event', {});
        const listed = PermissionManager.listGrants().some(x => x.id === id);
        return { pass: res.decision === 'ask' && !listed, detail: JSON.stringify({ decision: res.decision, listed }) };
      });
    }
  },
  {
    id: 'c86-new-recipient-exclusion',
    name: 'standing send_email covers known contacts; a stranger asks',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        // Seeds EmailApp.emails, the loaded mailbox. It used to overwrite the
        // email BLOB with an `emails` field — a key that stopped existing when
        // messages moved to the SQLite table, so the fixture and the code it
        // tested were both reading a ghost and the journey passed anyway.
        const original = EmailApp.emails;
        EmailApp.emails = [{ from: 'alice@example.com', to: 'me@me.com', cc: '', subject: 'hi', date: new Date().toISOString() }];
        await PermissionManager.grantAlways('send_email');
        const g = PermissionManager.listGrants().find(x => x.tool === 'send_email');
        const known = PermissionManager.resolve('send_email', { to: 'alice@example.com' });
        const fresh = PermissionManager.resolve('send_email', { to: 'stranger@nowhere.com' });
        await PermissionManager.revoke(g.id);
        EmailApp.emails = original;
        const pass = JSON.stringify(g.exclusions) === '["new_recipient"]'
          && known.decision === 'allow' && fresh.decision === 'ask' && /NEW recipient/.test(fresh.note || '');
        return { pass, detail: JSON.stringify({ known: known.decision, fresh: fresh.decision }) };
      });
    }
  },
  {
    id: 'c86-scoped-budget-main',
    name: 'scoped fs budget enforced in main; pre-flight never consumes',
    kind: 'det',
    async run({ page }) {
      // Deliberately OUTSIDE the default fs scopes (the runner's docs dir is
      // the apps dir, which default-allows and would bypass the grant) —
      // budgets only meter the GRANT path.
      return await page.evaluate(async (dir) => {
        await PermissionManager.grantScoped('fs:write', dir + '/c86', 'always');
        await PermissionManager._load();
        const g = PermissionManager.listGrants().find(x => x.tool === 'fs:write' && x.scope === dir + '/c86');
        await PermissionManager.setGrantBounds(g.id, { budget: 2 });
        const w1 = await window.electronAgentFS.write(dir + '/c86/a.txt', '1');
        const w2 = await window.electronAgentFS.write(dir + '/c86/b.txt', '2');
        const pre = await PermissionManager.checkScoped('fs_write', { path: dir + '/c86/c.txt' });
        const w3 = await window.electronAgentFS.write(dir + '/c86/c.txt', '3');
        await PermissionManager._load();
        const after = PermissionManager.listGrants().find(x => x.id === g.id);
        await PermissionManager.revoke(g.id);
        const pass = !w1.error && !w2.error && pre.decision === 'ask' && pre.budgetExhausted === true
          && !!w3.error && after?.usedCount === 2;
        return { pass, detail: JSON.stringify({ pre: pre.decision, used: after?.usedCount, w3: !!w3.error }) };
      }, '/tmp/anjadhe-eval-c86-scope');
    }
  }
];
