'use strict';
// Conversation wire adapter, shared by Mac and JavaScriptCore. No inference or
// execution state crosses this boundary. See MOBILE_STANDALONE conversation laws.
const ConversationSync = Object.freeze({
    id: s => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(s),
    messageKey(conversation, message) {
        const key = `${conversation.length}:${conversation}:${message}`;
        if (!this.id(key)) throw Error('Conversation IDs need migration before sync.');
        return key;
    },
    records(blob) {
        if (!blob || !Array.isArray(blob.conversations)) throw Error('Invalid conversation snapshot.');
        const records = new Map();
        const put = (type, id, fields) => {
            const key = type + '/' + id;
            if (!this.id(id) || records.has(key)) throw Error('Conversation IDs need migration before sync.');
            records.set(key, { type, id, fields });
        };
        for (const c of blob.conversations) {
            if (!c || typeof c !== 'object') throw Error('Invalid conversation.');
            if (c.private === true) continue; // Before reading any private content.
            if (!this.id(c.id) || typeof c.title !== 'string' || !Array.isArray(c.messages) || typeof c.createdAt !== 'string') throw Error('Conversation IDs need migration before sync.');
            if (c.todayKey != null && !this.id(c.todayKey)) throw Error('Invalid conversation thread.');
            put('conversation', c.id, { title: c.title, thread: c.todayKey || null, createdAt: c.createdAt,
                privacy: { untrusted: c.untrusted === true, contextMode: c.contextMode === 'simple' ? 'simple' : 'full' } });
            let parent = null;
            const seen = new Set();
            for (const m of c.messages) {
                if (!m || !['user', 'assistant'].includes(m.role)) continue;
                if (!this.id(m.id) || seen.has(m.id) || typeof m.content !== 'string' || typeof m.timestamp !== 'string') throw Error('Message IDs need migration before sync.');
                const parentId = m.parentId === undefined ? parent : m.parentId;
                if (parentId !== null && (!this.id(parentId) || !seen.has(parentId))) throw Error('Message parent is unavailable.');
                put('conversation-message', this.messageKey(c.id, m.id), { message: {
                    conversationId: c.id, id: m.id, parentId, role: m.role, content: m.content, timestamp: m.timestamp
                } });
                seen.add(m.id); parent = m.id;
            }
        }
        return records;
    },
    plan(before, after, materialized = []) {
        if (before?.conversations?.some(c => c?.private === true)) throw Error('Stored private history needs local recovery before sync.');
        const old = this.records(before), next = this.records(after), mutations = [];
        const current = new Map(materialized.map(r => [r.type + '/' + r.id, r]));
        const equal = (a, b) => {
            const stable = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
                ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
            return stable(a) === stable(b);
        };
        for (const [key, previous] of old) {
            const r = current.get(key);
            if (!r || r.deleted || Object.entries(previous.fields).some(([k, v]) => r.fields?.[k]?.versions?.length !== 1 || !equal(v, r.fields[k].value))) {
                throw Error('Conversation sync needs bootstrap or conflict review before editing.');
            }
        }
        for (const [key, record] of next) {
            const previous = old.get(key);
            if (!previous && current.has(key)) throw Error('Conversation identity collision needs review.');
            if (previous?.fields.privacy?.untrusted && !record.fields.privacy.untrusted) throw Error('Source conversation trust cannot be cleared.');
            if (previous?.fields.message && (previous.fields.message.parentId !== record.fields.message.parentId || previous.fields.message.role !== record.fields.message.role)) throw Error('An existing message cannot change parent or speaker.');
            const fields = Object.fromEntries(Object.entries(record.fields).filter(([k, v]) => !equal(previous?.fields[k], v)));
            if (Object.keys(fields).length) mutations.push({ type: record.type, id: record.id, mutation: { kind: 'edit', fields } });
        }
        // Missing messages/conversations could be a windowed snapshot. Never
        // interpret absence as deletion or silently discard existing history.
        for (const key of old.keys()) if (!next.has(key)) throw Error('Removing conversation history requires an explicit sync delete.');
        if (mutations.length > 256) throw Error('Conversation bootstrap needs a paged migration.');
        // Retain local-only metadata; private conversations never reach a local
        // journal or outbox through this adapter. Do not return caller secrets.
        const value = { ...after, conversations: after.conversations.filter(c => c.private !== true) };
        return { mutations, value };
    },
    project(records) {
        const live = records.filter(r => !r.deleted), conversations = [];
        for (const r of live.filter(r => r.type === 'conversation')) {
            const field = k => r.fields?.[k]?.value;
            const policies = r.fields?.privacy?.versions?.map(v => v.value) || [];
            const messages = live.filter(m => m.type === 'conversation-message' && m.fields?.message?.value?.conversationId === r.id)
                .map(m => ({ ...m.fields.message.value, syncConflicts: m.fields.message.versions.length > 1 ? m.fields.message.versions : [] }));
            // Traverse parent branches, never timestamps. Missing parents stay
            // recoverable as orphan records until their history arrives.
            const ordered = [], remaining = new Map(messages.map(m => [m.id, m]));
            const children = new Map();
            for (const m of messages) { if (!children.has(m.parentId)) children.set(m.parentId, []); children.get(m.parentId).push(m); }
            for (const list of children.values()) list.sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
            const pending = [...(children.get(null) || [])];
            while (pending.length) {
                const m = pending.pop();
                if (!remaining.delete(m.id)) continue;
                ordered.push(m); pending.push(...(children.get(m.id) || []));
            }
            conversations.push({ id: r.id, title: field('title') || '', todayKey: field('thread'), createdAt: field('createdAt'),
                untrusted: !policies.length || policies.some(p => p.untrusted), contextMode: !policies.length || policies.some(p => p.contextMode === 'simple') ? 'simple' : 'full',
                incomplete: ['title', 'thread', 'createdAt', 'privacy'].some(k => !r.fields?.[k]),
                hasBranches: [...children.values()].some(list => list.length > 1),
                messages: ordered, orphanMessages: [...remaining.values()], syncConflicts: Object.fromEntries(Object.entries(r.fields || {}).filter(([, v]) => v.versions.length > 1)) });
        }
        return { conversations: conversations.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            // Preserve messages whose conversation is not yet present or was deleted.
            orphanMessages: live.filter(m => m.type === 'conversation-message' && !conversations.some(c => c.id === m.fields?.message?.value?.conversationId)) };
    }
});
if (typeof module !== 'undefined' && module.exports) module.exports = ConversationSync;
