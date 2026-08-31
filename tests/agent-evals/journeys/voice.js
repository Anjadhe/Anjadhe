/**
 * Voice laws (docs/LIBRARY.md L2, js/apps/reader/voice-store.js +
 * voice-service.js). Pinned deterministically, no model in the loop —
 * VoiceService._applyStudyResult is the seam between the model call and
 * the store, and it takes fake "model output" happily:
 *
 *  - NEVER-BLANK: a study that returns no/empty styleGuide changes nothing
 *    (no page created, an existing page untouched).
 *  - USER EDITS WIN: a userEdited page's body survives every later study;
 *    the study still refreshes exemplars and stamps lastStudiedAt.
 *  - QUOTE-ANCHOR: an exemplar survives only if found verbatim (whitespace-
 *    normalized) in the sampled texts; paraphrases are dropped. Pinned
 *    exemplars survive re-studies; unpinned nominations are replaced.
 *  - the draft_in_style tool follows the library flag and sits in the
 *    untrusted blocklist unconditionally (V4).
 *  - the synced blob is record-merged (app_library in RECORD_MERGED_KEYS):
 *    a renderer write missing records it never loaded must not lose them,
 *    and removal happens through tombstones alone.
 */
const fs = require('fs');
const path = require('path');
const { installStubs } = require('../helpers.js');

module.exports = [
  {
    id: 'voice-study-never-blank',
    name: 'a study with no style guide changes nothing (never-blank)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const C = 'evalvoice-blank';
        const texts = [{ docId: 'd1', title: 'Essay One', text: 'The ferry smelled of diesel and cloves. I wrote most of this leaning on the rail.' }];
        const before = VoiceStore.pageFor(C);
        const r1 = VoiceService._applyStudyResult(C, { styleGuide: '', exemplars: [{ docTitle: 'Essay One', text: 'The ferry smelled of diesel and cloves. I wrote most of this leaning on the rail.' }] }, texts);
        const noPage = !VoiceStore.pageFor(C);
        const noExemplars = VoiceStore.exemplarsFor(C).length === 0;
        // Same law over an EXISTING page: garbage must not cost it.
        VoiceService._applyStudyResult(C, { styleGuide: 'Short declarative sentences. Concrete nouns.', exemplars: [] }, texts);
        const seeded = VoiceStore.pageFor(C);
        const r2 = VoiceService._applyStudyResult(C, { styleGuide: '   ', exemplars: [] }, texts);
        const after = VoiceStore.pageFor(C);
        const kept = !!seeded && !!after && after.body === seeded.body && after.updatedAt === seeded.updatedAt;
        const pass = !before && !!r1.error && noPage && noExemplars && !!r2.error && kept;
        return { pass, detail: JSON.stringify({ r1: r1.error, noPage, noExemplars, r2: r2.error, kept }) };
      });
    }
  },
  {
    id: 'voice-user-edits-never-rewritten',
    name: 'a userEdited style page keeps its body through later studies',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const C = 'evalvoice-edits';
        const texts = [{ docId: 'd1', title: 'Essay One', text: 'Narrow streets, carved doors, terrible coffee, wonderful people. I kept walking anyway.' }];
        VoiceStore.saveUserEdit(C, 'MY OWN GUIDE — hands off.');
        const res = VoiceService._applyStudyResult(C, {
          styleGuide: 'Model-written guide that must not land.',
          exemplars: [{ docTitle: 'Essay One', text: 'Narrow streets, carved doors, terrible coffee, wonderful people.' }]
        }, texts);
        const page2 = VoiceStore.pageFor(C);
        const exemplars = VoiceStore.exemplarsFor(C);
        const pass = res.applied === true && res.keptUserBody === true
          && page2.body === 'MY OWN GUIDE — hands off.'
          && page2.userEdited === true
          && !!page2.lastStudiedAt
          && exemplars.length === 1;
        return { pass, detail: JSON.stringify({ res, body: page2 && page2.body, userEdited: page2 && page2.userEdited, exemplars: exemplars.length }) };
      });
    }
  },
  {
    id: 'voice-exemplar-quote-anchor-and-pin',
    name: 'exemplars must be verbatim (paraphrases dropped); pinned ones survive re-study',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const C = 'evalvoice-anchor';
        const texts = [{ docId: 'd1', title: 'Essay One', text: 'The market opened before dawn, and the fishmongers argued in three languages about one price. Nobody left angry, which told me more than the price did.' }];
        const verbatim = 'The market opened before dawn, and the fishmongers argued in three languages about one price.';
        const r1 = VoiceService._applyStudyResult(C, {
          styleGuide: 'Observational, unhurried, ends on the meaning of small scenes.',
          exemplars: [
            { docTitle: 'Essay One', text: verbatim },
            { docTitle: 'Essay One', text: 'The fish market was very busy early in the morning and vendors haggled loudly.' }
          ]
        }, texts);
        const afterFirst = VoiceStore.exemplarsFor(C);
        const anchored = afterFirst.length === 1 && afterFirst[0].text === verbatim && afterFirst[0].docId === 'd1';

        // Pin it, re-study with a different nomination: the pin survives,
        // the old unpinned set would have been replaced.
        VoiceStore.setPinned(afterFirst[0].id, true);
        const second = 'Nobody left angry, which told me more than the price did.';
        VoiceService._applyStudyResult(C, { styleGuide: 'Updated guide.', exemplars: [{ docTitle: 'Essay One', text: second }] }, texts);
        const afterSecond = VoiceStore.exemplarsFor(C);
        const pinnedKept = afterSecond.some(e => e.text === verbatim && e.pinned);
        const newLanded = afterSecond.some(e => e.text === second && !e.pinned);
        const pass = r1.applied === true && r1.exemplarsValidated === 1 && anchored && pinnedKept && newLanded && afterSecond.length === 2;
        return { pass, detail: JSON.stringify({ r1, anchored, pinnedKept, newLanded, count: afterSecond.length }) };
      });
    }
  },
  {
    id: 'voice-draft-tool-flag-and-untrusted',
    name: 'draft_in_style ships always-on (flag graduated) and is untrusted-blocked (V4)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const present = AgentTools.definitions.some(d => d.function && d.function.name === 'draft_in_style')
          && !!AgentTools.handlers.draft_in_style;
        const blocked = AgentService.UNTRUSTED_BLOCKED_TOOLS.has('draft_in_style');
        const pass = present && blocked;
        return { pass, detail: JSON.stringify({ present, blocked }) };
      });
    }
  },
  {
    id: 'voice-store-record-merged',
    name: 'app_library merges by record: unloaded records survive a write, tombstones remove',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const mk = (id, updatedAt) => ({ id, collection: id, body: 'guide ' + id, createdAt: '2026-01-01T00:00:00Z', updatedAt });
        // Seed record A, then write a blob that never loaded A: the main-side
        // union (mergedForWrite) must keep it.
        StorageManager.set('library', { voicePages: [mk('vp_merge_a', '2026-01-01T00:00:00Z')], exemplars: [], tombstones: {} });
        StorageManager.set('library', { voicePages: [mk('vp_merge_b', '2026-01-02T00:00:00Z')], exemplars: [], tombstones: {} });
        const afterUnion = StorageManager.get('library') || {};
        const ids = (afterUnion.voicePages || []).map(p => p.id);
        const union = ids.includes('vp_merge_a') && ids.includes('vp_merge_b');
        // Removal is tombstone-only — the same write WITHOUT the tombstone
        // just proved it (A survived). With one, A must go and stay gone.
        StorageManager.set('library', { voicePages: [mk('vp_merge_b', '2026-01-02T00:00:00Z')], exemplars: [], tombstones: { vp_merge_a: new Date().toISOString() } });
        const afterTomb = StorageManager.get('library') || {};
        const ids2 = (afterTomb.voicePages || []).map(p => p.id);
        const removed = !ids2.includes('vp_merge_a') && ids2.includes('vp_merge_b');
        const pass = union && removed;
        return { pass, detail: JSON.stringify({ union, ids, removed, ids2 }) };
      });
    }
  },
  {
    id: 'voice-routine-injection',
    name: 'a digest routine with a voiceId carries the voice block; task mode and dead voices degrade silently',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        {
          VoiceStore.create('Routine Voice', 'evalvoice-routine');
          VoiceStore.saveUserEdit('evalvoice-routine', 'Short declarative sentences. One idea per line.');
          const voice = VoiceStore.resolve('Routine Voice');

          const prompt = { content: '<p>Summarize my day.</p>' };
          const cfg = (voiceId, runMode) => NotePrompts.config({ prompt: { offline: true, runMode, voiceId } });

          const injected = NotePrompts.bodyText(PromptFeed._withVoice(prompt, cfg(voice.id, 'digest')));
          const styled = injected.includes('WRITING VOICE')
            && injected.includes('Routine Voice')
            && injected.includes('Short declarative sentences')
            && injected.startsWith('Summarize my day.');
          const taskUntouched = PromptFeed._withVoice(prompt, cfg(voice.id, 'task')) === prompt;
          const deadUntouched = PromptFeed._withVoice(prompt, cfg('voice_gone', 'digest')) === prompt;

          const pass = styled && taskUntouched && deadUntouched;
          return { pass, detail: JSON.stringify({ styled, taskUntouched, deadUntouched, head: injected.slice(0, 60) }) };
        }
      });
    }
  },
  {
    id: 'voice-routine-create-tool',
    name: 'create_routine resolves a voice NAME to its id; wrong names and task mode error helpfully',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        {
          VoiceStore.create('Tool Voice', 'evalvoice-tool');
          VoiceStore.saveUserEdit('evalvoice-tool', 'Plain, warm, brief.');
          const voice = VoiceStore.resolve('Tool Voice');

          const made = await AgentTools.handlers.create_routine({
            title: 'Eval voice digest',
            prompt: 'Write me a two-line morning note.',
            trigger: { type: 'time', interval: 'daily', time: '08:00' },
            voice: 'Tool Voice'
          });
          const note = made.success ? NotePrompts.list().find(n => n.id === made.id) : null;
          const stored = note && NotePrompts.config(note).voiceId === voice.id
            && made.voice === 'Tool Voice';

          const wrong = await AgentTools.handlers.create_routine({
            title: 'Eval wrong voice', prompt: 'x',
            trigger: { type: 'time', interval: 'daily' }, voice: 'Nobody'
          });
          const wrongErrs = !!wrong.error && wrong.error.includes('Tool Voice');

          const cleared = await AgentTools.handlers.update_routine({ id: made.id, voice: '' });
          const clearedOk = cleared.success && NotePrompts.config(NotePrompts.list().find(n => n.id === made.id)).voiceId === null;

          const pass = !!stored && wrongErrs && clearedOk;
          return { pass, detail: JSON.stringify({ made, stored, wrongErrs, clearedOk }) };
        }
      });
    }
  },
  {
    id: 'voice-starter-import',
    name: 'a bundled sample voice imports into the throwaway library and indexes',
    kind: 'det',
    async run({ page, docs }) {
      const out = await page.evaluate(async () => {
        const list = await window.electronLibrary.starterVoices();
        const names = list.voices || [];
        const res = await window.electronLibrary.importStarter('Mark Twain');
        if (res.error) return { names, error: res.error };
        for (let i = 0; i < 60; i++) {
          const s = await window.electronLibrary.status();
          if (!s.queued && !s.indexing) break;
          await new Promise(r => setTimeout(r, 300));
        }
        const listing = await window.electronLibrary.list();
        const twain = (listing.docs || []).filter(d => d.collection === res.collection);
        // Idempotent: a second import copies nothing and errors nothing.
        const again = await window.electronLibrary.importStarter('Mark Twain');
        return { names, collection: res.collection, copied: res.copied, docs: twain.length, again };
      });
      if (out.error) return { pass: false, detail: out.error };
      const fileLanded = fs.existsSync(path.join(docs, '.library', 'Mark Twain', 'the-weather.md'));
      const pass = out.names.includes('Mark Twain') && out.names.includes('Abraham Lincoln')
        && out.copied === 4 && out.docs === 4 && fileLanded
        && out.again.success === true && out.again.copied === 0;
      return { pass, detail: JSON.stringify(out) };
    }
  },
  {
    id: 'voice-model-study-then-draft',
    name: 'model: real study writes a page + anchored exemplars; a draft turn calls draft_in_style',
    kind: 'model',
    async run({ page, docs }) {
      const poll = async (getter, timeoutMs) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          const r = await page.evaluate(getter);
          if (r) return r;
          await new Promise(res => setTimeout(res, 2000));
        }
        return { error: 'timed out' };
      };

      // A small corpus with a voice a model can actually describe.
      const lib = path.join(docs, '.library', 'voice-samples');
      fs.mkdirSync(lib, { recursive: true });
      fs.writeFileSync(path.join(lib, 'on-mornings.md'),
        '# On mornings\n\nI write before the house wakes up. Not because it is romantic — it is not, the kitchen is cold — but because the first hour is the only one nobody else has claimed. Guard the hour. Everything else negotiates.\n\nCoffee first, then the sentence I abandoned yesterday. It always looks worse than I remembered, which is useful: fixing it warms the engine better than starting fresh ever does.\n');
      fs.writeFileSync(path.join(lib, 'on-tools.md'),
        '# On tools\n\nEvery few months I catch myself shopping for a better notebook instead of writing. The notebook is never the problem. The problem is that the next paragraph is hard, and shopping is easy. Name the dodge and it loses most of its power.\n\nSo: one plain text file per project, one pen I do not love. Boring tools keep the argument where it belongs — with the work.\n');

      {
        // Voices are named entities over a collection folder (2026-08-08):
        // create the record the way the page does, before studying.
        await page.evaluate(async () => {
            const folder = await window.electronLibrary.createCollection('voice-samples');
            VoiceStore.create('Eval Writer', folder.collection || 'voice-samples');
        });

        // The eval Mac may have no local weights (a hosted-server user).
        // ANJADHE_EVAL_SERVER_URL/_MODEL point the eval app at an
        // OpenAI-compatible server for this run — nothing machine-specific
        // lives in the journey.
        const url = process.env.ANJADHE_EVAL_SERVER_URL || '';
        const model = process.env.ANJADHE_EVAL_SERVER_MODEL || '';
        if (url && model) {
          await page.evaluate(async (cfg) => {
            const s = StorageManager.get('agent-settings') || {};
            s.modelList = [{ id: 'eval_server', engine: 'server', model: cfg.model, baseUrl: cfg.url }];
            s.defaultModelId = 'eval_server';
            s.modelListVersion = 2;
            StorageManager.set('agent-settings', s);
            AgentService._brainSyncedOnce = false;
            await AgentService.setDefaultEntry('eval_server');
          }, { url, model });
        }

        // Index the corpus, then run a REAL study on the eval model.
        const status = await page.evaluate(async () => {
          await window.electronLibrary.scan();
          for (let i = 0; i < 60; i++) {
            const s = await window.electronLibrary.status();
            if (!s.queued && !s.indexing && s.docs > 0) return s;
            await new Promise(r => setTimeout(r, 300));
          }
          return await window.electronLibrary.status();
        });

        // Fire-and-poll: a minutes-long evaluate holding the renderer has
        // crashed the app before (the model-journeys lesson).
        await page.evaluate(() => {
          window.__evalVoice = null;
          VoiceService.study('voice-samples')
            .then(r => { window.__evalVoice = r; })
            .catch(e => { window.__evalVoice = { error: e.message }; });
        });
        const study = await poll(() => window.__evalVoice, 5 * 60 * 1000);
        if (study.error) return { pass: false, detail: 'study: ' + study.error };

        const stored = await page.evaluate(() => {
          const p = VoiceStore.pageFor('voice-samples');
          const ex = VoiceStore.exemplarsFor('voice-samples');
          return { body: (p?.body || '').length, exemplars: ex.length };
        });

        // A draft turn: the model should reach for draft_in_style first.
        await page.evaluate(() => {
          window.__evalChat = null;
          const conv = AgentService.createConversation();
          AgentService.sendMessage(
            'Draft a two-sentence note in my voice encouraging a friend who keeps buying new writing apps instead of writing.',
            { convId: conv.id }
          ).then(r => { window.__evalChat = r; })
           .catch(e => { window.__evalChat = { type: 'error', content: e.message }; });
        });
        const chat = await poll(() => window.__evalChat, 5 * 60 * 1000);
        const kitFetched = await page.evaluate(() =>
          window.__eval.calls.some(c => c.name === 'draft_in_style'));

        // The DOOR leg: the Voice card's "Draft in my voice…" pill opens a
        // pre-scoped conversation, and the user's message then usually has
        // NO voice wording at all. This is the case that shipped broken:
        // keyword domain-matching never sent the tool, so the button
        // produced a generic draft. openVoiceConversation is the fix.
        const doorSetup = await page.evaluate(() => {
          window.__evalChat2 = null;
          window.__eval.calls = [];
          const msg = 'Write a short two-sentence note encouraging a friend to finish their draft.';
          const voice = VoiceStore.resolve('Eval Writer');
          const conv = AgentService.openVoiceConversation(voice);
          AgentService.loadConversation(conv.id);
          AgentService.sendMessage(msg, { convId: conv.id })
            .then(r => { window.__evalChat2 = r; })
            .catch(e => { window.__evalChat2 = { type: 'error', content: e.message }; });
          // Diagnostics: whether the mechanics actually delivered — the
          // pre-scoped domain must ship the tool for THIS wording, the
          // instruction must be baked in, and the drawer must not open
          // silent (the greeting is the door's first word).
          return {
            domains: conv.scopedDomains || [],
            hasExtra: !!(conv.extraContext || '').includes('draft_in_style'),
            greeted: conv.messages.some(m => m.role === 'assistant' && /Eval Writer/.test(m.content || '')),
            toolShips: AgentTools.definitionsFor(msg, conv.scopedDomains)
              .some(d => d.function.name === 'draft_in_style')
          };
        });
        const chat2 = await poll(() => window.__evalChat2, 5 * 60 * 1000);
        const doorKit = await page.evaluate(() =>
          window.__eval.calls.some(c => c.name === 'draft_in_style'));

        const pass = stored.body > 0 && stored.exemplars >= 1
          && chat.type === 'text' && (chat.content || '').length > 40
          && kitFetched
          && chat2.type === 'text' && doorKit
          && doorSetup.greeted && doorSetup.toolShips;
        return {
          pass,
          detail: JSON.stringify({
            indexedDocs: status.docs, guideChars: stored.body, exemplars: stored.exemplars,
            kitFetched, chatType: chat.type, draft: (chat.content || '').slice(0, 120),
            doorKit, doorSetup, door: (chat2.content || '').slice(0, 120)
          })
        };
      }
    }
  }
];
