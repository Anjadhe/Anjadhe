'use strict';
// Fixed JSON boundary for bundled code, not a script/plugin execution API.
// Draft mutations return data only; the host owns approval and atomic commit.
const NenvaCore = (() => {
    const methods = new Map();
    methods.set('chat.transition', args => ChatTurn.transition(...args));
    methods.set('capture.inspect', ([blobs, kind, record, words, raw, before = '']) => {
        const C = ChatTurn.commitments(blobs);
        const matter = Object.assign({}, MatterCaptureRules, { M: MatterRecords });
        const occurrence = Object.assign({}, OccurrenceCaptureRules, { C });
        const capture = Object.assign({}, ThingCaptureRules, { MatterCapture: matter, OccurrenceCapture: occurrence });
        const facts = { today: C.today(), ...(kind === 'task' ? { commitment: record, repeats: C.repeats(record) } : { matter: record }) };
        const t = { type: kind };
        return { prompt: capture._prompt(t, facts, words, before), plan: capture.planFor(raw, t, facts, words) };
    });
    for (const name of ['worthLooking', 'prompt', 'vet', 'parse', 'nudge']) {
        methods.set(`claims.${name}`, args => ClaimCheck[name](...args));
    }
    methods.set('records.prepare', args => RecordTransaction.prepare(...args));
    methods.set('threads.snapshot', args => MobileRecords.snapshot(...args));
    for (const name of ['timeline', 'commitmentTimeline', 'commitmentWhen', 'ledgerWords',
        'senderTimeline', 'senderInfo', 'goalRow', 'pinnedFirst', 'events', 'statusOf',
        'lastAt', 'lastEventAt', 'preview', 'timeLabel', 'stampLabel', 'order', 'workState', 'readDoneText']) {
        methods.set(`threads.${name}`, args => ThreadCore[name](...args));
    }
    for (const name of ['today', 'day', 'time', 'repeats', 'occursOn', 'madeOn', 'nextOn', 'timeOn', 'isDone']) {
        methods.set(`calendar.${name}`, args => CommitmentCalendar[name](...args));
    }
    methods.set('threads.copy', () => ({ welcome: ThreadCore.WELCOME, work: ThreadCore.WORK_META }));
    return Object.freeze({
        version: 1,
        call(method, argumentsJSON) {
            if (!methods.has(method)) throw new Error('Unsupported core method');
            const args = JSON.parse(argumentsJSON);
            if (!Array.isArray(args) || args.length > 8) throw new Error('Invalid core arguments');
            return JSON.stringify(methods.get(method)(args));
        }
    });
})();
