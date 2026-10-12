/**
 * Upkeep tools — the last of the parity inventory (2026-10-08,
 * docs/AI_NATIVE.md, batch 6): what a person can see or do on the Chats
 * page, a trip, the Memory page and Appearance, for the assistant.
 *
 *   list_chats / delete_chat / detach_chat_record → the Chats page and the
 *       chat banner (AgentService.getConversationList, deleteConversation,
 *       detachRecordFromConversation). Private chats are never listed
 *       (PrivateChat P2); a routine's chat is removed with delete_routine.
 *   list_trips → the trip cards (Trips.all: code's itinerary and nights,
 *       the assistant's checked brief and offers).
 *   star_memory / confirm_memory / memory_needs_look → the Memory page's
 *       star and "Still true" (MemoryManager.edit) and its Needs a look.
 *   set_theme → Settings › Appearance (AppManager.setThemePref).
 *
 * Deleting a chat asks; the rest are the person's own word or reads. All
 * are blocked in untrusted turns.
 */
(() => {
    if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function') return;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const clean = (s, n = 160) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
    const conv = (id) => (typeof AgentService !== 'undefined' ? (AgentService.conversations || []).find(c => c && c.id === id) : null) || null;
    const repaintChats = () => {
        try { if (typeof AgentUI !== 'undefined' && AgentUI.renderHistorySidebar) AgentUI.renderHistorySidebar(); } catch { /* list only */ }
        try { if (typeof SimpleExperience !== 'undefined' && SimpleExperience.renderHistory) SimpleExperience.renderHistory(); } catch { /* list only */ }
    };

    AgentTools.GROUP_INFO.chats = 'the person\'s past chats: find one by words, delete one, or detach a chat from the task or record it is about';

    // ── Chats ──

    AgentTools.register({ type: 'function', function: {
        name: 'list_chats',
        description: 'The person\'s past chats, newest first: id, title, when, how many messages, what it is about, the last line. With query, only chats whose title or messages contain those words ("the chat about the dentist").',
        parameters: { type: 'object', properties: {
            query: { type: 'string' }, limit: { type: 'number', description: 'Default 15' }
        } }
    }}, (a = {}, ctx = {}) => {
        if (typeof AgentService === 'undefined') return { error: 'Chats are not available.' };
        const q = clean(a.query, 80).toLowerCase();
        const words = q ? q.split(' ').filter(Boolean) : [];
        let list = AgentService.getConversationList().filter(c => !c.standing && c.id !== ctx.convId);
        if (words.length) {
            list = list.filter(c => {
                const full = conv(c.id);
                const text = [c.title, c.recordLabel, ...((full && full.messages) || []).map(m => typeof m.content === 'string' ? m.content : '')].join(' ').toLowerCase();
                return words.every(w => text.includes(w));
            });
        }
        list.sort((x, y) => String(y.updatedAt || '').localeCompare(String(x.updatedAt || '')));
        const n = Math.max(1, Math.min(50, Number(a.limit) || 15));
        return { count: list.length, chats: list.slice(0, n).map(c => ({ id: c.id, title: clean(c.title, 100), updatedAt: c.updatedAt, messages: c.messageCount,
            about: c.recordLabel ? clean(c.recordLabel, 80) : undefined, last: c.preview ? clean(c.preview, 160) : undefined })) };
    }, { group: 'chats', readOnly: true, blockUntrusted: true });

    AgentTools.register({ type: 'function', function: {
        name: 'delete_chat',
        description: 'Delete one past chat (id from list_chats), as its delete button does. Not this chat, and not a routine\'s chat (delete_routine removes a routine).',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }}, (a = {}, ctx = {}) => {
        if (typeof AgentService === 'undefined') return { error: 'Chats are not available.' };
        const c = conv(String(a.id || ''));
        if (!c || c.private) return { error: 'No chat with that id. Call list_chats.' };
        if (c.id === ctx.convId) return { error: 'That is this chat; the person deletes it from the Chats page.' };
        if (c.standing) return { error: 'That is a routine\'s chat; remove the routine with delete_routine.' };
        if (AgentService.isConversationStreaming && AgentService.isConversationStreaming(c.id)) return { error: 'That chat is still answering; try again when it finishes.' };
        const title = c.title;
        AgentService.deleteConversation(c.id);
        repaintChats();
        return { success: true, deleted: clean(title, 100) };
    }, { group: 'chats', ask: true, blockUntrusted: true, describe: (a) => `Delete the chat <b>${esc(clean((conv(String(a.id || '')) || {}).title || a.id, 100))}</b>` });

    AgentTools.register({ type: 'function', function: {
        name: 'detach_chat_record',
        description: 'Stop a chat being about the task or record it is attached to (the banner\'s detach). With no id, this chat.',
        parameters: { type: 'object', properties: { id: { type: 'string', description: 'A chat id from list_chats; default this chat' } } }
    }}, (a = {}, ctx = {}) => {
        if (typeof AgentService === 'undefined') return { error: 'Chats are not available.' };
        const c = conv(String(a.id || ctx.convId || ''));
        if (!c) return { error: 'No chat with that id.' };
        if (!c.recordKey) return { success: true, note: 'That chat is not attached to anything.' };
        const was = c.recordLabel || c.recordKey;
        AgentService.detachRecordFromConversation(c.id);
        repaintChats();
        return { success: true, detachedFrom: clean(was, 100) };
    }, { group: 'chats', blockUntrusted: true });

    // ── Trips ──

    AgentTools.register({ type: 'function', function: {
        name: 'list_trips',
        description: 'The trips nenva put together from bookings in mail: each with its dates, the itinerary (one line per booking, with confirmation codes), the nights with no stay booked (arithmetic), and nenva\'s brief and offers when it has written them.',
        parameters: { type: 'object', properties: {} }
    }}, () => {
        if (typeof Trips === 'undefined') return { error: 'Trips are not available.' };
        let trips = [];
        try { trips = Trips.all(); } catch { trips = []; }
        if (!trips.length) return { trips: [], note: 'No trips in the bookings nenva has.' };
        return { trips: trips.map(t => ({ key: t.key, name: t.name, dates: Trips.dates(t), start: t.start, end: t.end,
            itinerary: Trips.itinerary(t).map(x => x.line), nightsWithNoStay: Trips.gaps(t),
            brief: t.review && t.review.brief ? clean(t.review.brief, 400) : undefined,
            offers: t.review && Array.isArray(t.review.offers) && t.review.offers.length ? t.review.offers.map(o => clean(o.label || o.text || o, 120)) : undefined })) };
    }, { group: 'matters', readOnly: true, blockUntrusted: true, dataClass: 'email' });

    // ── Memory: the star, Still true, Needs a look ──

    AgentTools.register({ type: 'function', function: {
        name: 'star_memory',
        description: 'Star a remembered fact so it is carried into every chat ("always remember that"), or unstar it, as the Memory page\'s star does. Use the id from recall_memory.',
        parameters: { type: 'object', properties: { id: { type: 'string' }, starred: { type: 'boolean' } }, required: ['id', 'starred'] }
    }}, (a = {}) => {
        if (typeof MemoryManager === 'undefined') return { error: 'Memory is not available.' };
        const f = MemoryManager.get(String(a.id || ''));
        if (!f) return { error: 'No remembered fact with that id. Call recall_memory.' };
        MemoryManager.edit(f.id, { starred: !!a.starred });
        return { success: true, id: f.id, text: f.text, starred: !!a.starred };
    }, { group: 'memory', blockUntrusted: true });

    AgentTools.register({ type: 'function', function: {
        name: 'memory_needs_look',
        description: 'The remembered facts not confirmed in six months (the Memory page\'s Needs a look): ask the person if they still hold, then confirm_memory, update_memory or delete_memory each.',
        parameters: { type: 'object', properties: {} }
    }}, () => {
        if (typeof MemoryManager === 'undefined') return { error: 'Memory is not available.' };
        const list = MemoryManager.needsLook();
        return { count: list.length, facts: list.slice(0, 30).map(f => ({ id: f.id, text: f.text, heading: MemoryManager.headingLabel ? MemoryManager.headingLabel(f.heading) : f.heading,
            asOf: MemoryManager.asOfLabel ? MemoryManager.asOfLabel(f) || undefined : undefined })) };
    }, { group: 'memory', readOnly: true, blockUntrusted: true });

    AgentTools.register({ type: 'function', function: {
        name: 'confirm_memory',
        description: 'The person says a remembered fact still holds ("yes, still true"): it counts as confirmed today, as "Still true" on the Memory page does.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }}, (a = {}) => {
        if (typeof MemoryManager === 'undefined') return { error: 'Memory is not available.' };
        const f = MemoryManager.get(String(a.id || ''));
        if (!f) return { error: 'No remembered fact with that id.' };
        MemoryManager.edit(f.id, {});
        return { success: true, id: f.id, text: f.text };
    }, { group: 'memory', blockUntrusted: true });

    // ── Appearance ──

    AgentTools.register({ type: 'function', function: {
        name: 'set_theme',
        description: 'Light, dark, or follow the Mac (system), as Settings › Appearance does. This Mac only.',
        parameters: { type: 'object', properties: { theme: { type: 'string', enum: ['light', 'dark', 'system'] } }, required: ['theme'] }
    }}, (a = {}) => {
        if (typeof AppManager === 'undefined' || !AppManager.setThemePref) return { error: 'Not available.' };
        if (!['light', 'dark', 'system'].includes(a.theme)) return { error: 'theme must be light, dark or system.' };
        AppManager.setThemePref(a.theme);
        return { success: true, theme: a.theme };
    }, { group: 'help', blockUntrusted: true });
})();
