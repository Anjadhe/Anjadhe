'use strict';
const { createHash } = require('node:crypto');
const { scopeFor, MonitorError } = require('./slack-monitor-policy');
const Matters = require('../core/matters');
const fail = () => { throw new MonitorError('routine_unavailable', 'Review the Slack routine and monitoring scope.'); };

/** A scheduled review consumes already-filed observations. No Slack fetch,
 * no second model, no whole-workspace scan and no raw message excerpts. */
function digest({ store, intake, routineId }) {
    const state = intake._read(); intake._guard(state.revision);
    const conv = store.get('app_agent-conversations')?.conversations?.find(c => c.id === routineId);
    const watch = conv?.standing?.config?.slackWatch;
    if (!watch || !conv.standing.config.offline || !Array.isArray(watch.kinds)
        || !watch.kinds.length || watch.kinds.some(k => !['request', 'commitment', 'change', 'blocker'].includes(k))
        || !Number.isSafeInteger(watch.since)) fail();
    const scope = scopeFor(watch), approved = state.config.scope;
    if (scope.workspaceId !== approved.workspaceId || scope.userId !== approved.userId
        || scope.conversationIds.some(id => !approved.conversationIds.includes(id))) fail();
    const seen = conv.standing.slackSeen || {};
    const items = [];
    const candidates = Object.values(store.get('app_matters')?.matters || {})
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 500);
    for (const m of candidates) {
        if (m.state !== 'open' || m.evidenceNeedsReview || m.sources?.at(-1)?.tell === 'now'
            || m.slackScopes?.some(s => s.workspaceId !== scope.workspaceId || s.userId !== scope.userId
                || !scope.conversationIds.includes(s.channelId))) continue;
        const source = (m.sources || []).filter(s => s.slack && !s.slack.invalidated
            && s.slack.workspaceId === scope.workspaceId && s.slack.userId === scope.userId
            && scope.conversationIds.includes(s.slack.channelId) && watch.kinds.includes(s.slack.kind)
            && Date.parse(s.filedAt || s.at) >= watch.since).at(-1);
        if (!source || source.tell === 'file' || source.tell === 'now') continue;
        const fingerprint = createHash('sha256').update(JSON.stringify([m.id, m.status, m.next?.what, m.next?.by, m.state])).digest('hex');
        if (seen[m.id] === fingerprint) continue;
        items.push({ id: m.id, fingerprint, title: String(m.title || '').slice(0, 150),
            status: String(m.status || '').slice(0, 300), url: Matters.sourceUrl(source) });
        if (items.length === 10) break;
    }
    const safe = value => value.replace(/[\[\]()*_`<>\\\r\n]/g, ' ');
    return { items: items.map(({ id, fingerprint }) => ({ id, fingerprint })),
        content: items.length ? 'From your watched Slack conversations (coverage may be incomplete):\n\n'
            + items.map(i => `- **${safe(i.title)}**: ${safe(i.status)}${i.url ? ` [Open Slack](${i.url})` : ''}`).join('\n') : '' };
}
module.exports = { digest };
