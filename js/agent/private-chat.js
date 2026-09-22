/**
 * PrivateChat — the laws of a private assistant chat (2026-09-13).
 *
 * A private chat is a conversation that is NOT remembered. It is an ordinary
 * conversation object carrying `private: true` that lives only in
 * AgentService.conversations for as long as it is open. The laws, each
 * enforced at one seam (docs/ASSISTANT_CONTEXT.md "Private chats"):
 *
 *   P1 Never stored. _saveConversations writes `persistable()` only, so the
 *      chat never reaches the synced `agent-conversations` blob, the sync
 *      journal, a backup or another Mac, and a reload ends it.
 *   P2 Never listed. It is not in the history sidebar or the prompt
 *      suggestions' recent-chats line.
 *   P3 Never learned from. No memory extraction and no conversation-goal
 *      derivation run over it, and BLOCKED_TOOLS (memory writes, task runs
 *      that store the transcript) are refused both from the tool list and in
 *      AgentTools.execute.
 *   P4 Not logged by content. LLM Logs and AI Activity keep that a call
 *      happened, where it went and its size (the ledger is the disclosure,
 *      docs/CLOUD_PRIVACY.md L1), but not the words.
 *   P5 Ends when left. Switching to any other conversation discards it; a
 *      reply still streaming is stopped first.
 *
 * Personal context is a separate, per-chat choice riding the existing
 * `contextMode` field: a private chat starts with personal info OFF
 * ('simple') unless the user ticks the box. Reading the user's data is
 * allowed when they tick it; remembering is never allowed.
 *
 * What a private chat does NOT undo: things the user asks the assistant to
 * DO (create a task, send an email) are real actions and are kept, with
 * their approvals and the undo ledger, exactly as in any chat.
 */
const PrivateChat = {
    TITLE: 'Private chat',
    REDACTED: '[private chat — content not logged]',

    // Tools whose whole effect is to remember something beyond the chat.
    BLOCKED_TOOLS: new Set([
        'save_memory',     // writes a memory
        'update_memory',   // rewrites a memory page
        'start_task',      // a task stores the chat's transcript with the run
    ]),

    isPrivate(conv) {
        return !!(conv && conv.private === true);
    },

    /** The conversations that may be written to storage (P1). */
    persistable(conversations) {
        return (conversations || []).filter(c => c && c.private !== true);
    },

    /** Shape of a new private conversation. */
    create({ usePersonalInfo = false, now = new Date() } = {}) {
        const conv = {
            id: 'private_' + now.getTime() + '_' + Math.random().toString(36).slice(2, 6),
            title: this.TITLE,
            private: true,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            messages: []
        };
        if (!usePersonalInfo) conv.contextMode = 'simple';
        return conv;
    },

    isBlockedTool(name) {
        return this.BLOCKED_TOOLS.has(name);
    },

    /** What a refused tool call returns to the model (P3). */
    blockedResult(name) {
        const why = name === 'start_task'
            ? 'a task keeps a copy of the conversation, and this chat is private'
            : 'nothing from a private chat is remembered';
        return {
            error: `${name} is not available in a private chat: ${why}. ` +
                'Tell the user plainly; if they want it saved, they can leave private mode and ask again.'
        };
    },

    /**
     * Strip the words from an LLM log entry in place, keeping its shape and
     * every number (P4). Called by LLMLogger.addEntry.
     */
    redactEntry(entry) {
        if (!entry) return entry;
        const R = this.REDACTED;
        entry.privateChat = true;
        if (entry.systemPrompt != null) entry.systemPrompt = R;
        if (entry.userPrompt != null) entry.userPrompt = R;
        if (entry.response != null) entry.response = R;
        if (entry.subject != null) entry.subject = null;
        if (Array.isArray(entry.requestMessages)) {
            entry.requestMessages = entry.requestMessages.map(m => ({ ...m, preview: '' }));
        }
        if (Array.isArray(entry.toolCalls)) {
            entry.toolCalls = entry.toolCalls.map(tc => ({ name: tc && tc.name, args: R }));
        }
        return entry;
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = PrivateChat;
