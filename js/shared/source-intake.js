'use strict';
/** Explicit pasted-source review. Reuses the desktop's filing and placement
 * judgments. Source text is evidence only: no tools or external effects.
 * Every model dispatch is checkpointed by ChatTurn; only approval writes.
 */
const SourceIntake = Object.freeze({
    matters: b => Object.values(b.matters?.matters || {}).filter(ChatTurn.available),
    senders: () => Object.assign({}, SenderRecords, SenderMembership),
    start(b, event, now) {
        if (!/^pasted:[a-f0-9]{64}$/.test(event.sourceId || '') || event.text.length > 2500) throw Error('Paste at most 2,500 characters for filing.');
        const observation = { id: event.sourceId, source: 'email', own: false, at: now, text: event.text, title: event.text.split('\n')[0].slice(0, 160) };
        const f = MatterRecords.observation(observation);
        if (this.matters(b).some(m => m.sources?.some(s => s.id === f.id))) throw Error('This source has already been filed.');
        return { observation, f, stage: 'matter', cands: MatterRecords.candidates(f, this.matters(b)), versions: b._versions || {} };
    },
    unchanged(b, s) { return RecordTransaction.keys.every(k => (b._versions?.[k] || '') === (s.versions[k] || '')); },
    request(s) {
        if (s.stage === 'place') return this.senders().prompt(s.items, s.shown);
        if (s.stage === 'narrow') return MatterRecords._samePrompt(MatterRecords._describe(s.target), {
            title: s.j.title || s.f.subject, kind: s.j.kind, when: s.j.when, time: s.j.time,
            status: s.j.status, from: s.f.meta.name, latest: s.f.summary || s.f.subject
        }, s.why);
        return MatterRecords._prompt(s.f, s.cands, Date.now(), [], [], s.stage === 'second');
    },
    advance(b, s, raw) {
        if (!this.unchanged(b, s)) throw Error('Records changed while reading this source. Nothing was filed. Start a new review.');
        if (s.stage === 'place') {
            const placements = this.senders().vet(raw, s.items, s.shown);
            if (placements.length !== 1 || (!placements[0].sender && !placements[0].new?.allGood)) throw Error('The thread could not be verified. Nothing was filed.');
            s.placement = placements[0]; s.stage = 'review'; return;
        }
        if (s.stage === 'narrow') {
            if (typeof raw?.same !== 'boolean') throw Error('The source identity check did not finish. Nothing was filed.');
            if (!raw.same) { s.j = { ...s.j, about: 'new', change: 'new' }; s.raw = { ...s.raw, about: 'new', change: 'new' }; }
        } else {
            const j = MatterRecords.vet(raw, s.f, s.cands);
            if (!j) throw Error('The source could not be checked. Nothing was filed.');
            if (s.stage !== 'second' || !['new', 'none'].includes(j.about)) { s.j = j; s.raw = raw; s.usedCandidates = s.cands.map(m => m.id); }
            if (s.j.about === 'none') { s.stage = 'none'; return; }
            if (s.stage === 'matter' && s.j.about === 'new') {
                const near = MatterRecords.near(s.f, s.j, this.matters(b), s.cands);
                if (near.length) { s.cands = [...s.cands, ...near]; s.stage = 'second'; return; }
            }
            s.target = this.matters(b).find(m => m.id === s.j.about);
            s.why = s.target && MatterRecords.disagrees(s.f, s.j, s.target);
            if (s.why) { s.stage = 'narrow'; return; }
        }
        const draft = RecordTransaction.prepare(b, { id: s.f.id + ':preview', operation: 'matter.file', args: {
            observation: s.observation, judgment: s.raw, candidateIds: s.usedCandidates
        } });
        if (!draft.ok) throw Error(draft.error);
        const S = this.senders(), sb = { senders: {}, place: {}, aliases: {}, tries: {}, ...b.senders };
        s.matter = draft.record;
        const home = S.senderOfIn(sb, s.matter.id, { matterOf: id => b.matters?.matters?.[id] });
        if (home && sb.senders?.[home]?.state !== 'archived') {
            s.placement = { key: s.matter.id, sender: home }; s.stage = 'review'; return;
        }
        s.items = S.eligible([s.matter], [], () => false);
        if (s.items.length !== 1) throw Error('This item could not be placed in a thread. Nothing was filed.');
        s.shown = S.shown(sb); s.stage = 'place';
    },
    prepare(b, command) {
        const fail = error => ({ ok: false, error, changes: {} });
        const s = command.args?.source;
        if (!s || s.stage !== 'review' || !this.unchanged(b, s)) return fail('Records changed. Start a new source review.');
        const draft = RecordTransaction.prepare(b, { id: command.id, operation: 'matter.file', args: {
            observation: s.observation, judgment: s.raw, candidateIds: s.usedCandidates
        } });
        if (!draft.ok || draft.replay) return draft;
        const S = this.senders(), sb = JSON.parse(JSON.stringify(b.senders || {}));
        for (const k of ['senders', 'place', 'aliases', 'tries']) {
            if (sb[k] != null && (typeof sb[k] !== 'object' || Array.isArray(sb[k]))) return fail('Saved threads need recovery.');
            sb[k] = Object.assign(Object.create(null), sb[k] || {});
        }
        const p = s.placement;
        if (p?.key !== draft.record.id || (p.sender && (!sb.senders[S.resolve(sb, p.sender)] || sb.senders[S.resolve(sb, p.sender)].state === 'archived'))) return fail('This thread is unavailable.');
        S.apply(sb, [p], Date.now(), 'you');
        const home = sb.place[draft.record.id]?.sender, sender = sb.senders[home];
        if (!sender) return fail('This source needs a thread.');
        // Keep the exact reviewed excerpt with the source, not just a model summary.
        draft.record.sources.find(x => x.id === s.f.id).pastedText = s.observation.text;
        draft.changes.senders = sb;
        Object.assign(draft.receipt, { operation: 'source.file', label: 'Filed source', threadKey: home });
        draft.sender = sender;
        draft.rows = [['Thread', sender.name], ['All good', sender.allGood], ['Status', draft.record.status || draft.record.state],
            ['Date', draft.record.when?.date || 'No date'], ['Next step', draft.record.next?.what || 'None'],
            ['Action evidence', draft.record.next?.quote || 'None'], ['Deadline evidence', draft.record.next?.byQuote || 'None'],
            ['Commitment', 'No commitment is created by filing. Ask in the thread to add one.']];
        return draft;
    }
});
