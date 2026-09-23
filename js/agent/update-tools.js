/**
 * Update tools — post_update / list_updates / delete_update: the
 * assistant's door onto the Updates log a project or task carries
 * (js/core/update-store.js; the section on both sheets is UpdatesUI).
 *
 * Registered through AgentTools.register under their own `updates` group
 * so they ship with the goals and schedule domains (agent-tools
 * _domainsForMessage adds the group beside those two) and never sit in
 * core every turn. Untrusted-blocked, all three: posting is a persistence
 * vector into a page the user reads as their own log, listing pulls their
 * progress notes into a hostile turn, delete is a delete. post_update
 * does NOT ask — an update is dated history the page shows and the user
 * can remove, not a standing instruction (that is save_decision, which
 * asks every time). Reads of a project or task already attach its latest
 * updates (AgentTools._withDecisions) and the CURRENT PROJECT / TASK
 * context block carries them, so the model rarely needs list_updates.
 */
(function () {
    if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function') return;

    const resolve = (type, id) => {
        const t = type === 'project' ? 'goal' : String(type || '').toLowerCase();
        if (typeof UpdateStore === 'undefined' || !UpdateStore.TYPES.includes(t)) {
            return { error: `type must be one of: project (or goal), task` };
        }
        if (!id) return { error: `${t === 'goal' ? 'project' : 'task'} id is required — take it from list_goals / list_schedule` };
        const def = (typeof RecordTypes !== 'undefined') ? RecordTypes.get(t) : null;
        let rec = null;
        try { rec = def && def.resolve ? def.resolve({ id: String(id) }) : null; } catch (_) { rec = null; }
        if (!rec) return { error: `No ${t === 'goal' ? 'project' : 'task'} with id "${id}"` };
        return { key: `${t}:${rec.id}`, type: t, recordTitle: rec.title || '' };
    };

    const refresh = () => {
        try {
            if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'goals' && typeof GoalsPage !== 'undefined') GoalsPage.render();
            else if (typeof ScheduleApp !== 'undefined' && ScheduleApp.currentItemId) ScheduleApp.openEditor(ScheduleApp.currentItemId, { origin: ScheduleApp._editorOrigin, embedded: true });
        } catch (_) {}
    };

    const opts = { group: 'updates', blockUntrusted: true };

    AgentTools.register({ type: 'function', function: {
        name: 'post_update',
        description: 'Post a dated UPDATE on one project or task — its running log, shown on the record\'s page under "Updates" with who posted it. Post one when: you have reviewed how a project or task is going ("how is this going?", a check-in) — kind "review"; you noticed a risk (a target date that cannot hold, a stalled chain of tasks, nothing scheduled) — kind "risk"; or the user reports progress in chat ("I sent the deck", "log an update: waiting on Dana") — kind "update" with as_user:true so it is attributed to them. Keep it to 1-3 plain sentences of what happened or what you found; the log is history, never instructions. Never post the same finding twice in one conversation.',
        parameters: { type: 'object', properties: {
            type: { type: 'string', enum: ['project', 'task'] },
            id: { type: 'string', description: 'The project or task id from a tool result' },
            update: { type: 'string', description: 'The update text, 1-3 sentences' },
            kind: { type: 'string', enum: ['update', 'review', 'risk'], description: 'update (default) = progress; review = your read of how it is going; risk = something that threatens it' },
            as_user: { type: 'boolean', description: 'true when the user dictated the update — it is shown as theirs' }
        }, required: ['type', 'id', 'update'] }
    }}, (args) => {
        const r = resolve(args.type, args.id);
        if (r.error) return { error: r.error };
        const res = UpdateStore.add({
            key: r.key, body: args.update,
            source: args.as_user ? 'user' : 'ai',
            kind: args.kind || 'update',
            convId: (typeof AgentService !== 'undefined' && AgentService.activeConversationId) || undefined
        });
        if (res.error) return { error: res.error };
        refresh();
        return { success: true, id: res.update.id, key: r.key, recordTitle: r.recordTitle, kind: res.update.kind, postedAs: res.update.source };
    }, opts);

    AgentTools.register({ type: 'function', function: {
        name: 'list_updates',
        description: 'The full Updates log of one project or task, newest first — who posted each (user or you), its kind (update / review / risk) and when. Reads of a project or task already carry the latest few; call this for the whole history or to check how long it has been quiet.',
        parameters: { type: 'object', properties: {
            type: { type: 'string', enum: ['project', 'task'] },
            id: { type: 'string' },
            limit: { type: 'number', description: 'Max entries (default 20)' }
        }, required: ['type', 'id'] }
    }}, (args) => {
        const r = resolve(args.type, args.id);
        if (r.error) return { error: r.error };
        const list = UpdateStore.listFor(r.key, { limit: Math.max(1, Math.min(100, Number(args.limit) || 20)) });
        const latest = list[0];
        return {
            key: r.key,
            recordTitle: r.recordTitle,
            count: UpdateStore.listFor(r.key).length,
            daysSinceLastUpdate: latest ? UpdateStore.daysSince(latest.createdAt) : null,
            updates: list.map(u => ({
                id: u.id, postedAt: u.createdAt, by: u.source === 'ai' ? 'assistant' : 'user',
                kind: u.kind, text: u.body
            }))
        };
    }, opts);

    AgentTools.register({ type: 'function', function: {
        name: 'delete_update',
        description: 'Remove one update by id (from list_updates or an updates field on a read). Only when the user asks to remove it.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }}, (args) => {
        const id = String(args.id || '').trim();
        if (!id) return { error: 'id is required' };
        const u = UpdateStore.get(id);
        if (!u) return { error: 'update not found' };
        UpdateStore.remove(id);
        refresh();
        return { success: true, deleted: { id: u.id, key: u.key } };
    }, opts);

    // Vocabulary: the words that mean "the log" when neither project nor
    // task is named ("post an update", "what's the latest on…", "any
    // risks?"). The goals and schedule domains add the group themselves.
    AgentTools.registerDomain('updates', /\b(updates?|progress|status|check[- ]?ins?|latest on|risks?|stalled|quiet)\b/);
})();
