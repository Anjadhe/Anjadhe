/**
 * R1 — the identity ledger (docs/ROUTINE_TRIGGERS.md; laws T1–T4, T7).
 *
 * A trigger fires once per THING, decided against a per-routine
 * processed-identity set — not against a timestamp. These journeys are the
 * doc's own eval checklist: batch (D1, the headline — it failed for every
 * pre-R1 build), exactly-once across ticks and Macs, backfill (D2), file
 * identity + seeding (T3/T4), and the ledger bound.
 *
 * Fixtures are written where production reads (the doc's eval law):
 * EmailApp.emails for mail, real files through the real agent-fs-list IPC
 * for the folder trigger — the 2019-mtime file is a genuine file with a
 * genuinely forged mtime, stamped from the runner's node side.
 */
const fs = require('fs');
const path = require('path');

const RESET = `
  (() => {
    // app_notes is RECORD-MERGED: a removal without a tombstone unions right
    // back from the store, so eval routines were quietly surviving their own
    // reset (found when a resurrected task-mode routine claimed another
    // journey's mail). Tombstone what we drop.
    const all = NotePrompts._readNotes();
    const notes = all.filter(n => !/^eval:/.test(n.title || ''));
    const at = new Date().toISOString();
    const tombstones = {};
    for (const n of all) if (!notes.includes(n)) tombstones[n.id] = at;
    NotePrompts._writeNotes(notes, Object.keys(tombstones).length ? tombstones : null);
    RoutineEngine.state.runs = {};
    RoutineEngine.state.errors = {};
    RoutineEngine.state.seen = {};
    RoutineEngine.local.queue = [];
    RoutineEngine.local.checks = {};
    RoutineEngine.saveLocal();
    if (RoutineEngine._timer) { clearInterval(RoutineEngine._timer); RoutineEngine._timer = null; }
    RoutineEngine._draining = false;
  })()
`;

module.exports = [
  {
    // D1, the headline. Five invoices produced three runs on 2026-08-03
    // because the trigger fired on the newest match and stamped the marker
    // past the rest. Three matching messages in one poll window must be
    // three runs, each ABOUT its own message.
    id: 'r1-batch-three-invoices-three-runs',
    name: 'three matching emails in one window fire three runs, then nothing re-fires (T2/D1)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const origEmails = EmailApp.emails;
        const origLoaded = EmailApp._dataLoaded;
        EmailApp._dataLoaded = true;
        EmailApp.emails = [];
        const res = await AgentTools.handlers.create_routine({
          title: 'eval: invoices', prompt: 'capture it',
          trigger: { type: 'email', subject: 'invoice' }
        });
        const mk = (id, subject, ms) => ({
          messageId: id, id, from: 'billing@acme.com', subject,
          labels: ['INBOX'], internalDate: String(Date.now() + ms),
          date: new Date(Date.now() + ms).toISOString()
        });
        // Three invoices land between two ticks — the exact 16:26/16:29
        // shape that lost a run live.
        EmailApp.emails = [
          mk('e_i1', 'Invoice INV-2033', 1000),
          mk('e_i2', 'Invoice INV-2041', 2000),
          mk('e_i3', 'Invoice INV-2052', 3000)
        ];
        const all = [];
        const origRun = PromptFeed.runRoutine;
        PromptFeed.runRoutine = async (p, ctx) => { all.push({ id: p.id, suffix: ctx && ctx.suffix, identity: ctx && ctx.identity }); return {}; };
        await RoutineEngine.tick();
        // The tick also runs whatever starter routines the demo profile
        // seeds — this journey's claims are about ITS routine only.
        const mine = () => all.filter(r => r.id === res.id);
        const firstPass = mine().length;
        // Same mailbox, next tick: every identity is stamped — zero re-fires.
        await RoutineEngine.tick();
        const ran = mine();
        PromptFeed.runRoutine = origRun;
        EmailApp.emails = origEmails;
        EmailApp._dataLoaded = origLoaded;

        const identities = ran.map(r => r.identity).sort();
        const eachAboutItsOwn = ran.every(r => {
          const m = /^mail:e_i(\d)$/.exec(r.identity || '');
          return m && new RegExp(['INV-2033', 'INV-2041', 'INV-2052'][m[1] - 1]).test(r.suffix || '');
        });
        const pass = firstPass === 3 && ran.length === 3
          && JSON.stringify(identities) === JSON.stringify(['mail:e_i1', 'mail:e_i2', 'mail:e_i3'])
          && eachAboutItsOwn
          && RoutineEngine.queue().every(q => q.routineId !== res.id);
        return { pass, detail: JSON.stringify({ firstPass, total: ran.length, identities, eachAboutItsOwn }) };
      }, RESET);
    }
  },
  {
    // T1 + T7: once per thing across ticks on one Mac, and once per thing
    // across MACS — the seen union is what turns the fail-open duplicate
    // fire on a second Mac into a no-op.
    id: 'r1-exactly-once-across-ticks-and-macs',
    name: 'a processed identity never re-fires, and the seen set unions across writes (T1, T7)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const origEmails = EmailApp.emails;
        const origLoaded = EmailApp._dataLoaded;
        EmailApp._dataLoaded = true;
        EmailApp.emails = [];
        const res = await AgentTools.handlers.create_routine({
          title: 'eval: once', prompt: 'log it',
          trigger: { type: 'email', subject: 'receipt' }
        });
        EmailApp.emails = [{
          messageId: 'e_once', id: 'e_once', from: 'shop@acme.com', subject: 'Receipt 77',
          labels: ['INBOX'], internalDate: String(Date.now() + 1000),
          date: new Date(Date.now() + 1000).toISOString()
        }];
        let runs = 0;
        const origRun = PromptFeed.runRoutine;
        // Starter routines share the tick; count this routine's runs only.
        PromptFeed.runRoutine = async (p) => { if (p.id === res.id) runs++; return {}; };
        await RoutineEngine.tick();
        await RoutineEngine.tick();
        PromptFeed.runRoutine = origRun;
        const onePerTicks = runs === 1;

        // The second-Mac half. This Mac's renderer writes a blob that has
        // never heard of e_once (the pre-merge-state hazard); the write-path
        // union must keep the stamp — and a foreign Mac's stamp for a
        // message WE have not processed must merge in and suppress our fire.
        StorageManager.set('promptFeed', {
          items: [], runs: {}, errors: {},
          seen: { [res.id]: { ids: { 'mail:e_other': Date.now() }, floorMs: 0, sig: 'email' } }
        });
        const stored = StorageManager.get('promptFeed');
        const mine = stored.seen && stored.seen[res.id] && stored.seen[res.id].ids;
        const unionKept = !!(mine && mine['mail:e_once'] && mine['mail:e_other']);

        // Reload (the startup/refresh path) and confirm neither identity fires.
        RoutineEngine.load();
        const fired = await RoutineEngine._firedFor(
          NotePrompts.list().find(n => n.id === res.id), Date.now());
        EmailApp.emails = origEmails;
        EmailApp._dataLoaded = origLoaded;
        const pass = onePerTicks && unionKept && fired.fired.length === 0;
        return { pass, detail: JSON.stringify({ runs, unionKept, refires: fired.fired.length, ids: mine && Object.keys(mine) }) };
      }, RESET);
    }
  },
  {
    // D2: a message SENT after arming but FETCHED late (the fullSyncAccount
    // re-pull) used to be invisible forever, because the marker had moved
    // past its internalDate. The floor no longer moves; the id decides.
    id: 'r1-backfill-late-mail-fires',
    name: 'late-fetched mail older than the last run still fires; pre-arming mail never does (D2, T3)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const origEmails = EmailApp.emails;
        const origLoaded = EmailApp._dataLoaded;
        EmailApp._dataLoaded = true;
        const now = Date.now();
        const mk = (id, subject, ms, labels = ['INBOX']) => ({
          messageId: id, id, from: 'ap@northgate.com', subject, labels,
          internalDate: String(ms), date: new Date(ms).toISOString()
        });
        // A non-matching message makes the first evaluation happen (the
        // ledger initializes on first sight of a non-empty mailbox), fixing
        // the floor at arm time.
        EmailApp.emails = [mk('e_noise', 'Newsletter', now + 500)];
        const res = await AgentTools.handlers.create_routine({
          title: 'eval: backfill', prompt: 'log it',
          trigger: { type: 'email', subject: 'invoice' }
        });
        const note = () => NotePrompts.list().find(n => n.id === res.id);
        const first = await RoutineEngine._firedFor(note(), now);

        // A run happens later — under the old engine this moved the marker.
        RoutineEngine.state.runs[res.id] = new Date(now + 60000).toISOString();
        RoutineEngine.save();

        // The late arrival: sent AFTER arming, internalDate BEFORE that
        // last run. Old `_sinceMs` = max(lastRun, armed) hid it forever.
        EmailApp.emails = [...EmailApp.emails, mk('e_late', 'Invoice 88', now + 5000)];
        const late = await RoutineEngine._firedFor(note(), now + 120000);

        // Pre-arming mail re-pulled by a full sync stays history (T3).
        EmailApp.emails = [...EmailApp.emails, mk('e_ancient', 'Invoice 12', now - 86400000)];
        const ancient = await RoutineEngine._firedFor(note(), now + 180000);
        EmailApp.emails = origEmails;
        EmailApp._dataLoaded = origLoaded;

        const lateFired = late.fired.some(f => f.identity === 'mail:e_late');
        const ancientQuiet = !ancient.fired.some(f => f.identity === 'mail:e_ancient');
        const pass = first.fired.length === 0 && lateFired && ancientQuiet;
        return { pass, detail: JSON.stringify({
          first: first.fired.length, lateFired, ancientQuiet,
          lateIds: late.fired.map(f => f.identity), ancientIds: ancient.fired.map(f => f.identity)
        }) };
      }, RESET);
    }
  },
  {
    // T4 + T3's seeding half, against real files through the real IPC. A
    // folder's existing contents are seeded (arming replays nothing), and a
    // file copied in wearing a 2019 mtime is still a new thing.
    id: 'r1-file-identity-not-mtime',
    name: 'arming seeds the folder; a 2019-mtime copy still fires; nothing fires twice (T3, T4)',
    kind: 'det',
    async run({ page, docs }) {
      // Node side: a pre-existing file BEFORE arming...
      fs.writeFileSync(path.join(docs, 'ledger-existing.csv'), 'seeded');
      const setup = await page.evaluate(async ({ reset, dir }) => {
        eval(reset);
        const res = await AgentTools.handlers.create_routine({
          title: 'eval: ledger files', prompt: 'file it',
          trigger: { type: 'file', folder: dir, pattern: 'ledger-*.csv' }
        });
        const note = NotePrompts.list().find(n => n.id === res.id);
        const pre = await RoutineEngine._firedFor(note, Date.now());
        return { id: res.id, preFires: pre.fired.length };
      }, { reset: RESET, dir: docs });

      // ...then the forged copy: a brand-new file whose mtime says 2019
      // (`cp -p`). The mtime is genuinely old on disk — the real
      // agent-fs-list reports it — so a time-based trigger cannot see it.
      const forged = path.join(docs, 'ledger-2019.csv');
      fs.writeFileSync(forged, 'old-looking newcomer');
      const old = new Date('2019-03-01T00:00:00Z');
      fs.utimesSync(forged, old, old);

      const out = await page.evaluate(async (id) => {
        const note = NotePrompts.list().find(n => n.id === id);
        const post = await RoutineEngine._firedFor(note, Date.now());
        // Simulate the drain's stamp, then confirm the fire is consumed.
        for (const f of post.fired) RoutineEngine.stampSeen(id, f.identity);
        const again = await RoutineEngine._firedFor(note, Date.now());
        return {
          fired: post.fired.map(f => f.label),
          identities: post.fired.map(f => f.identity),
          refires: again.fired.length
        };
      }, setup.id);

      const pass = setup.preFires === 0
        && out.fired.length === 1 && out.fired[0] === 'ledger-2019.csv'
        && /\|\d+$/.test(out.identities[0] || '')   // name|size, never mtime
        && out.refires === 0;
      return { pass, detail: JSON.stringify({ setup, out }) };
    }
  },
  {
    // The bound, in both places it must hold: the renderer's prune and the
    // write-path union (a cap applied only at stamp time would be
    // resurrected by its own save).
    id: 'r1-ledger-bound-and-floor',
    name: 'the seen set stays capped at 500 newest through prune AND merge; the floor only tightens',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const now = Date.now();
        const rid = 'eval_bound_' + Math.random().toString(36).slice(2);
        const entry = { ids: {}, floorMs: now - 1000, sig: 'email' };
        for (let i = 0; i < 600; i++) entry.ids['mail:m' + i] = now - i * 1000;
        RoutineEngine.state.seen[rid] = entry;

        // Renderer-side prune: newest 500 by stamp survive.
        RoutineEngine._pruneSeen(entry);
        const afterPrune = Object.keys(entry.ids).length;
        const newestKept = !!entry.ids['mail:m0'];
        const oldestGone = !entry.ids['mail:m599'];

        // Write-path: rebuild 600 and save — the merge in main must cap it
        // too, and must keep the HIGHER floor when a write carries a lower.
        for (let i = 0; i < 600; i++) entry.ids['mail:m' + i] = now - i * 1000;
        RoutineEngine.save();
        const storedA = (StorageManager.get('promptFeed').seen || {})[rid];
        StorageManager.set('promptFeed', {
          items: [], runs: {}, errors: {},
          seen: { [rid]: { ids: {}, floorMs: now - 999999, sig: 'email' } }
        });
        const storedB = (StorageManager.get('promptFeed').seen || {})[rid];
        const pass = afterPrune === 500 && newestKept && oldestGone
          && storedA && Object.keys(storedA.ids).length === 500
          && storedB && storedB.floorMs === now - 1000
          && Object.keys(storedB.ids).length === 500;
        return { pass, detail: JSON.stringify({
          afterPrune, newestKept, oldestGone,
          storedACount: storedA && Object.keys(storedA.ids).length,
          floorKept: storedB && storedB.floorMs === now - 1000
        }) };
      }, RESET);
    }
  },
  {
    // R3 (T5/D3): the sync path KNOWS which messages are new and hands the
    // delta straight to the engine — the trigger no longer waits out the
    // 5-minute scheduler poll. Driven through the REAL deltaSync, with only
    // the Gmail IPC stubbed at EmailApp's own seams.
    id: 'r3-new-mail-pushes-to-engine',
    name: 'a delta-synced new email fires its routine without the scheduler poll (R3, T5)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);   // also stops the scheduler — any fire below is the push path
        const orig = {
          emails: EmailApp.emails, loaded: EmailApp._dataLoaded,
          accounts: EmailApp.accounts, hist: EmailApp.lastHistoryIds,
          fh: EmailApp._fetchHistory, fm: EmailApp._fetchMessagesByIds,
          ai: EmailApp.aiInsightsEnabled, run: PromptFeed.runRoutine
        };
        try {
          EmailApp._dataLoaded = true;
          EmailApp.emails = [];
          EmailApp.aiInsightsEnabled = false;   // no insight queueing side-quests
          EmailApp.accounts = [{ email: 'evals@example.test', provider: 'gmail' }];
          EmailApp.lastHistoryIds = { 'evals@example.test': 'h1' };
          EmailApp._fetchHistory = async () => ({ historyId: 'h2', newMessageIds: ['e_push'] });
          EmailApp._fetchMessagesByIds = async () => ({ emails: [{
            messageId: 'e_push', id: 'e_push', threadId: 't_push',
            account: 'evals@example.test', from: 'billing@acme.com',
            subject: 'Invoice 4471', snippet: 'Your invoice', labels: ['INBOX'],
            internalDate: String(Date.now() + 1000), date: new Date(Date.now() + 1000).toISOString()
          }] });

          const res = await AgentTools.handlers.create_routine({
            title: 'eval: push', prompt: 'capture it',
            trigger: { type: 'email', subject: 'invoice' }
          });
          const ran = [];
          PromptFeed.runRoutine = async (p, ctx) => { if (p.id === res.id) ran.push(ctx); return {}; };

          await EmailApp.deltaSync();
          // The push nudge is debounced ~1s; the scheduler stays stopped, so
          // whatever fires within this wait came through the push alone.
          await new Promise(r => setTimeout(r, 2200));

          const pass = ran.length === 1
            && ran[0].identity === 'mail:e_push'
            && /Invoice 4471/.test(ran[0].suffix || '');
          return { pass, detail: JSON.stringify({ runs: ran.length, identity: ran[0]?.identity }) };
        } finally {
          EmailApp.emails = orig.emails; EmailApp._dataLoaded = orig.loaded;
          EmailApp.accounts = orig.accounts; EmailApp.lastHistoryIds = orig.hist;
          EmailApp._fetchHistory = orig.fh; EmailApp._fetchMessagesByIds = orig.fm;
          EmailApp.aiInsightsEnabled = orig.ai; PromptFeed.runRoutine = orig.run;
        }
      }, RESET);
    }
  },
  {
    // R6 (D6): the fired THING is the run's scope. Two matching emails must
    // produce two runs, each naming ITS OWN email by id with the
    // don't-search directive — the wording that stops a run from re-doing
    // every earlier match's work.
    id: 'r6-run-scoped-to-the-thing',
    name: 'each fire\'s context names its own email by id and forbids re-searching the mailbox (R6, D6)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const origEmails = EmailApp.emails;
        const origLoaded = EmailApp._dataLoaded;
        EmailApp._dataLoaded = true;
        EmailApp.emails = [];
        const res = await AgentTools.handlers.create_routine({
          title: 'eval: scoped', prompt: 'capture the invoice',
          trigger: { type: 'email', subject: 'invoice' }
        });
        const mk = (id, subject, ms) => ({
          messageId: id, id, from: 'billing@acme.com', subject,
          labels: ['INBOX'], internalDate: String(Date.now() + ms),
          date: new Date(Date.now() + ms).toISOString()
        });
        EmailApp.emails = [mk('e_s1', 'Invoice INV-1', 1000), mk('e_s2', 'Invoice INV-2', 2000)];
        const note = () => NotePrompts.list().find(n => n.id === res.id);
        const r = await RoutineEngine._firedFor(note(), Date.now());
        EmailApp.emails = origEmails;
        EmailApp._dataLoaded = origLoaded;

        const byId = Object.fromEntries(r.fired.map(f => [f.identity, f.suffix || '']));
        const scoped = (id, subj) => new RegExp(`email id: ${id}`).test(byId[`mail:${id}`] || '')
          && new RegExp(subj).test(byId[`mail:${id}`] || '')
          && /THIS one email only/.test(byId[`mail:${id}`] || '')
          && /Do not search the mailbox/.test(byId[`mail:${id}`] || '')
          && !new RegExp(`email id: ${id === 'e_s1' ? 'e_s2' : 'e_s1'}`).test(byId[`mail:${id}`] || '');
        const pass = r.fired.length === 2 && scoped('e_s1', 'INV-1') && scoped('e_s2', 'INV-2');
        return { pass, detail: JSON.stringify({ fired: r.fired.length, suffix: (byId['mail:e_s1'] || '').slice(0, 140) }) };
      }, RESET);
    }
  },
  {
    // Ownership (Ram, 2026-08-03): when an armed task-mode email routine and
    // the ambient insight sweep watch the same mail, the routine — explicit
    // user intent — owns writing the task. The sweep's automatic
    // syncActionItemsToSchedule defers; unclaimed mail, and mail matched
    // only by a DIGEST routine (which cannot write), keep today's behavior.
    id: 'ownership-routine-claims-email-tasks',
    name: 'the sweep leaves task-writing to an armed task-mode routine that matches the mail',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const taskCount = (needle) => ((StorageManager.get('schedule') || {}).scheduleItems || [])
          .filter(i => new RegExp(needle).test(i.title || '')).length;
        const mk = (id, subject) => ({
          messageId: id, id, from: 'billing@acme.com', subject,
          snippet: 'your monthly bill', labels: ['INBOX'],
          internalDate: String(Date.now()), date: new Date().toISOString()
        });
        const due = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
        const analysis = (text) => ({
          actionRequired: true,
          actionItems: [{ text, dueDate: due }]
        });

        // An armed task-mode routine over invoice mail...
        const acts = await AgentTools.handlers.create_routine({
          title: 'eval: owns invoices', prompt: 'capture the invoice', runMode: 'task',
          trigger: { type: 'email', subject: 'invoice' }
        });
        // ...and a digest routine over receipts (cannot write → claims nothing).
        await AgentTools.handlers.create_routine({
          title: 'eval: reads receipts', prompt: 'summarize it',
          trigger: { type: 'email', subject: 'receipt' }
        });

        // Claimed: the sweep must write nothing.
        EmailApp.syncActionItemsToSchedule(mk('e_own1', 'Invoice OWN-1'), analysis('Pay invoice OWN-1'));
        const claimed = taskCount('OWN-1');
        // Unclaimed mail keeps the sweep's auto-task.
        EmailApp.syncActionItemsToSchedule(mk('e_own2', 'Dentist appointment'), analysis('Confirm dentist OWN-2'));
        const unclaimed = taskCount('OWN-2');
        // Digest-matched mail keeps it too — a digest cannot replace it.
        EmailApp.syncActionItemsToSchedule(mk('e_own3', 'Receipt 9'), analysis('File receipt OWN-3'));
        const digestMatched = taskCount('OWN-3');

        // Deleting the routine hands ownership back for future analyses.
        NotePrompts.remove(acts.id);
        EmailApp.syncActionItemsToSchedule(mk('e_own4', 'Invoice OWN-4'), analysis('Pay invoice OWN-4'));
        const afterDelete = taskCount('OWN-4');

        const pass = claimed === 0 && unclaimed === 1 && digestMatched === 1 && afterDelete === 1;
        return { pass, detail: JSON.stringify({ claimed, unclaimed, digestMatched, afterDelete }) };
      }, RESET);
    }
  }
];
