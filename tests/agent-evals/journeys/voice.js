/**
 * Writing-voice laws (docs/LIBRARY.md L2, js/core/voice-store.js +
 * voice-service.js + js/agent/voice-tools.js). Pinned deterministically,
 * no model in the loop — VoiceService._applyStudyResult is the seam
 * between the model call and the store, and it takes fake "model output"
 * happily:
 *
 *  - NEVER-BLANK: a study that returns no/empty styleGuide changes nothing
 *    (no page created, an existing page untouched).
 *  - USER EDITS WIN: a userEdited page's body survives every later study;
 *    the study still refreshes exemplars and stamps lastStudiedAt.
 *  - QUOTE-ANCHOR: an exemplar survives only if found verbatim (whitespace-
 *    normalized) in the sampled texts; paraphrases are dropped. Pinned
 *    exemplars survive re-studies; unpinned nominations are replaced.
 *  - ONE voice: the self voice is the only record the tool and the page
 *    read; draft_in_style takes no voice argument, errors point at
 *    Settings › Writing voice while it is off or unstudied, and returns
 *    the kit once studied; the tool is core (present with Reader
 *    uninstalled), in its own `voice` group summoned by style-of-me
 *    wording, and untrusted-blocked (V4).
 *  - the synced blob is record-merged (app_library in RECORD_MERGED_KEYS):
 *    a renderer write missing records it never loaded must not lose them,
 *    and removal happens through tombstones alone.
 *  - routines carry NO voice (custom voices and the routine voice option
 *    were removed 2026-09-02): a stored voiceId is ignored by config().
 */
const fs = require('fs');
const path = require('path');

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
    name: 'draft_in_style is core, in the voice group, summoned by style-of-me wording, untrusted-blocked (V4)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const def = AgentTools.definitions.find(d => d.function && d.function.name === 'draft_in_style');
        const present = !!def && !!AgentTools.handlers.draft_in_style;
        const blocked = AgentService.UNTRUSTED_BLOCKED_TOOLS.has('draft_in_style');
        const core = AgentTools._dynamicTools.draft_in_style?.source === 'voice'
          && AgentTools._toolGroups.draft_in_style === 'voice';
        // No voice argument any more — one voice, the user's own.
        const noVoiceArg = !!def && !(def.function.parameters?.properties || {}).voice;
        const words = ['draft a reply in my voice', 'make it sound like me', 'rewrite this the way I write', 'put it in my own words'];
        const summoned = words.every(w => AgentTools._domainsForMessage(w).has('voice'));
        const quiet = !AgentTools._domainsForMessage('what is on my schedule today').has('voice');
        const pass = present && blocked && core && noVoiceArg && summoned && quiet;
        return { pass, detail: JSON.stringify({ present, blocked, core, noVoiceArg, summoned, quiet }) };
      });
    }
  },
  {
    id: 'voice-single-self-voice-tool-flow',
    name: 'draft_in_style: off → error naming Settings; on but unstudied → error; studied → the kit (self voice only)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        // A clean slate for THIS journey: the blob is record-merged, so
        // removal goes through the store's own tombstoning delete.
        const existing = VoiceStore.selfVoice();
        if (existing) VoiceStore.deletePage(existing.collection || '');
        const off = await AgentTools.handlers.draft_in_style({});
        const offErr = !!off.error && /Settings › Writing voice/.test(off.error);

        const folder = await window.electronLibrary.createCollection('My voice');
        const made = VoiceStore.createSelf({ documents: true, notes: true }, folder.collection || 'My voice');
        const isOn = !!made.voice && made.voice.self === true && VoiceStore.isOn() && !VoiceStore.isStudied();
        const unstudied = await AgentTools.handlers.draft_in_style({});
        const unstudiedErr = !!unstudied.error && /Study/.test(unstudied.error);

        const c = made.voice.collection || '';
        const texts = [{ docId: 'note:n1', title: 'A note', text: 'I keep the sentences short. The long ones have to earn it.' }];
        VoiceService._applyStudyResult(c, {
          styleGuide: 'Short sentences. Long ones must earn their length.',
          exemplars: [{ docTitle: 'A note', text: 'I keep the sentences short. The long ones have to earn it.' }]
        }, texts);
        const kit = await AgentTools.handlers.draft_in_style({});
        const kitOk = !kit.error && kit.voice === 'My voice'
          && /Short sentences/.test(kit.styleGuide)
          && Array.isArray(kit.exemplars) && kit.exemplars.length === 1
          && /USER'S voice/.test(kit.instructions);

        // Turning off removes the lens (page + exemplars) via tombstones.
        VoiceStore.deletePage(c);
        const gone = !VoiceStore.selfVoice() && VoiceStore.exemplarsFor(c).length === 0;
        const pass = offErr && isOn && unstudiedErr && kitOk && gone;
        return { pass, detail: JSON.stringify({ offErr, isOn, unstudiedErr, kitOk, gone, kitErr: kit.error }) };
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
    id: 'voice-routines-carry-no-voice',
    name: 'routines have no voice: config() drops a stored voiceId, create_routine ignores a voice arg',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const cfg = NotePrompts.config({ prompt: { offline: true, runMode: 'digest', voiceId: 'voice_legacy' } });
        const dropped = !('voiceId' in cfg);
        const made = await AgentTools.handlers.create_routine({
          title: 'Eval no-voice digest',
          prompt: 'Write me a two-line morning note.',
          trigger: { type: 'time', interval: 'daily', time: '08:00' },
          voice: 'Anyone'
        });
        const note = made.success ? NotePrompts.list().find(n => n.id === made.id) : null;
        const ignored = !!note && !made.voice && !('voiceId' in NotePrompts.config(note));
        const def = AgentTools.definitions.find(d => d.function && d.function.name === 'create_routine');
        const schemaClean = !!def && !(def.function.parameters.properties || {}).voice;
        const pass = dropped && ignored && schemaClean;
        return { pass, detail: JSON.stringify({ dropped, ignored, schemaClean, made }) };
      });
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

      // A small corpus with a voice a model can actually describe, in the
      // self voice's own folder.
      const lib = path.join(docs, '.library', 'My voice');
      fs.mkdirSync(lib, { recursive: true });
      fs.writeFileSync(path.join(lib, 'on-mornings.md'),
        '# On mornings\n\nI write before the house wakes up. Not because it is romantic — it is not, the kitchen is cold — but because the first hour is the only one nobody else has claimed. Guard the hour. Everything else negotiates.\n\nCoffee first, then the sentence I abandoned yesterday. It always looks worse than I remembered, which is useful: fixing it warms the engine better than starting fresh ever does.\n');
      fs.writeFileSync(path.join(lib, 'on-tools.md'),
        '# On tools\n\nEvery few months I catch myself shopping for a better notebook instead of writing. The notebook is never the problem. The problem is that the next paragraph is hard, and shopping is easy. Name the dodge and it loses most of its power.\n\nSo: one plain text file per project, one pen I do not love. Boring tools keep the argument where it belongs — with the work.\n');

      {
        // Turn the voice on the way Settings does, before studying.
        await page.evaluate(async () => {
            const existing = VoiceStore.selfVoice();
            if (existing) VoiceStore.deletePage(existing.collection || '');
            const folder = await window.electronLibrary.createCollection('My voice');
            VoiceStore.createSelf({ documents: true }, folder.collection || 'My voice');
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
          const c = VoiceStore.selfVoice().collection || '';
          VoiceService.study(c)
            .then(r => { window.__evalVoice = r; })
            .catch(e => { window.__evalVoice = { error: e.message }; });
        });
        const study = await poll(() => window.__evalVoice, 5 * 60 * 1000);
        if (study.error) return { pass: false, detail: 'study: ' + study.error };

        const stored = await page.evaluate(() => {
          const p = VoiceStore.selfVoice();
          const ex = VoiceStore.exemplarsFor(p.collection || '');
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

        // The DOOR leg: Settings › Writing voice's "Draft in my voice…"
        // opens a pre-scoped conversation, and the user's message then
        // usually has NO voice wording at all. This is the case that
        // shipped broken once: keyword domain-matching never sent the
        // tool, so the button produced a generic draft.
        const doorSetup = await page.evaluate(() => {
          window.__evalChat2 = null;
          window.__eval.calls = [];
          const msg = 'Write a short two-sentence note encouraging a friend to finish their draft.';
          const conv = AgentService.openScopedConversation({
            domains: ['voice'],
            extraContext: 'For ANY request to write, draft, or rewrite something, call draft_in_style FIRST and imitate the exemplars it returns.',
            greeting: 'You\'re drafting in your own voice.'
          });
          AgentService.loadConversation(conv.id);
          AgentService.sendMessage(msg, { convId: conv.id })
            .then(r => { window.__evalChat2 = r; })
            .catch(e => { window.__evalChat2 = { type: 'error', content: e.message }; });
          return {
            domains: conv.scopedDomains || [],
            hasExtra: !!(conv.extraContext || '').includes('draft_in_style'),
            greeted: conv.messages.some(m => m.role === 'assistant' && /own voice/.test(m.content || '')),
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
