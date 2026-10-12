/**
 * Sender tools (docs/SENDERS.md M2): the assistant reads and keeps the
 * senders, the long-lived things in the person's life that each have a
 * thread (Auto insurance, Your dental, Maya's music classes). Every action a
 * person can take on a sender in Threads is here too (minimum UI, agent
 * parity): start one, rename it, say what "all good" means, put a thing in
 * it, fold two together, archive one.
 *
 * Reads and words-only changes (create, rename, all good) do not ask: they
 * are what the person just said, and the thread shows them. Moving a thing,
 * folding two senders and archiving change where things live and ask every
 * time, as join_matters does. Blocked in untrusted turns (a sender's items
 * carry what others wrote).
 */
(() => {
    if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function') return;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const ready = () => typeof Senders !== 'undefined';
    const nameOf = (id) => { const s = ready() ? Senders.get(String(id || '')) : null; return s ? s.name : 'a sender that is not there'; };
    const titleOf = (key) => {
        if (/^matter:/.test(key) && typeof Matters !== 'undefined') { const m = Matters.get(key); return m ? Matters.titleOf(m) : null; }
        const id = String(key).replace(/^task:/, '');
        const c = typeof Commitments !== 'undefined' ? Commitments.get(id) : null;
        return c ? c.title : null;
    };
    // A thing's key from what the model passes: a folder id ("matter:…"), a commitment id, or "task:<id>".
    const keyOf = (v) => { v = String(v || '').trim(); return /^(matter|task):/.test(v) ? v : v ? `task:${v}` : ''; };
    const brief = (s) => ({ id: s.id, name: s.name, allGood: s.allGood || undefined, confirmed: s.confirmed || undefined,
        archived: s.state === 'archived' || undefined, items: Senders.members(s.id).length, open: Senders.members(s.id, { open: true }).length });
    const opts = { group: 'senders', blockUntrusted: true, dataClass: 'email' };
    AgentTools.GROUP_INFO.senders = 'the things in the person\'s life nenva looks after, each with its own thread (Auto insurance, Your dental, a goal): list, read, start, rename, move a thing into one, fold two, archive, keep or remove a fact about one, attach a document or a routine to one, and carry a general chat into a thing\'s thread (hand_off_to_sender)';

    AgentTools.register({ type: 'function', function: {
        name: 'list_senders',
        description: 'The things in the user\'s life nenva looks after, each with its own thread on the Threads page (e.g. "Auto insurance", "Your dental", "Maya\'s music classes", a goal). Each has a name, what "all good" means for it, and how many items (mail-and-text items and commitments) it holds.',
        parameters: { type: 'object', properties: {
            search: { type: 'string', description: 'Words in the name' },
            archived: { type: 'boolean', description: 'Include archived ones (default false)' }
        } }
    }}, (args = {}) => {
        if (!ready()) return { error: 'Not available in this build.' };
        let list = Senders.all({ archived: !!args.archived });
        if (args.search) { const q = String(args.search).toLowerCase(); list = list.filter(s => s.name.toLowerCase().includes(q)); }
        return { count: list.length, senders: list.slice(0, 40).map(brief) };
    }, opts);

    AgentTools.register({ type: 'function', function: {
        name: 'get_sender',
        description: 'One sender in full, as its info page shows it: its name, what "all good" means for it, every item in it (id, title, open or settled), what is coming up, and the amounts, numbers and places its mail gave. Read an item further with get_matter or get_commitment.',
        parameters: { type: 'object', properties: { id: { type: 'string', description: 'The sender id (from list_senders), e.g. "sender:auto-insurance-…"' } }, required: ['id'] }
    }}, (args = {}) => {
        if (!ready()) return { error: 'Not available in this build.' };
        const s = Senders.get(String(args.id || ''));
        if (!s || s.builtIn) return { error: 'No sender with that id. Call list_senders for ids.' };
        const open = new Set(Senders.members(s.id, { open: true }));
        // What its info page shows (M3), from the same builder.
        let info = null;
        try { const row = typeof ThreadsPage !== 'undefined' ? ThreadsPage.rowFor(s.id) : null; info = row && row.type === 'sender' ? ThreadsPage.infoFor(row) : null; } catch { info = null; }
        return { ...brief(s), itemsIn: Senders.members(s.id).map(k => ({ id: k, title: titleOf(k) || undefined, open: open.has(k) })),
            comingUp: info && info.upcoming.length ? info.upcoming.map(u => ({ id: u.key, title: u.title, date: u.date, time: u.time || undefined, dueBy: u.by || undefined })) : undefined,
            fromMail: info && info.facts.length ? info.facts.map(f => ({ what: f.label, value: f.value, from: f.from })) : undefined,
            youToldNenva: (s.facts || []).length ? s.facts.map(f => ({ id: f.id, fact: f.text, said: f.at })) : undefined,
            // Everything else nenva knows about it, from the one reader (M8).
            ...(() => { const k = typeof SenderKnows !== 'undefined' ? SenderKnows.of(s.id) : null; if (!k) return {};
                return { decisions: k.decisions.length ? k.decisions.map(d => ({ on: d.on, item: d.key, decision: d.text, at: d.at })) : undefined,
                    updates: k.updates.length ? k.updates : undefined,
                    watching: k.watching.notes.length || k.watching.lookAgain ? k.watching : undefined,
                    routines: k.routines.length ? k.routines.map(r => ({ id: r.id, title: r.title, latest: r.last || undefined })) : undefined,
                    documents: k.documents.length ? k.documents : undefined,
                    jobs: k.jobs.length ? k.jobs : undefined }; })() };
    }, opts);

    AgentTools.register({ type: 'function', function: {
        name: 'create_sender',
        description: 'Start keeping track of a thing in the user\'s life as its own thread, when they ask ("start keeping track of Maya\'s music classes"). Name it the way they would; "all_good" is one sentence of what it looks like when nothing about it needs them. Never a whole area of life ("School", "Health"); never one event.',
        parameters: { type: 'object', properties: {
            name: { type: 'string' }, all_good: { type: 'string' }
        }, required: ['name'] }
    }}, (args = {}) => {
        if (!ready()) return { error: 'Not available in this build.' };
        const s = Senders.create(args.name, args.all_good || '', { by: 'you' });
        return s ? { created: true, ...brief(s) } : { error: 'A name is needed.' };
    }, opts);

    AgentTools.register({ type: 'function', function: {
        name: 'rename_sender',
        description: 'Rename a sender when the user says what to call it. Also confirms a sender nenva started on its own.',
        parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] }
    }}, (args = {}) => {
        if (!ready()) return { error: 'Not available in this build.' };
        const r = Senders.rename(String(args.id || ''), args.name);
        return r ? { renamed: true, from: r.before.name, ...brief(r.sender) } : { error: 'No sender with that id, or no name. Call list_senders for ids.' };
    }, opts);

    AgentTools.register({ type: 'function', function: {
        name: 'set_sender_all_good',
        description: 'Change what "all good" means for a sender, when the user says what they want from it ("for my car insurance I mostly care that the price stays fair"). One plain sentence.',
        parameters: { type: 'object', properties: { id: { type: 'string' }, all_good: { type: 'string' } }, required: ['id', 'all_good'] }
    }}, (args = {}) => {
        if (!ready()) return { error: 'Not available in this build.' };
        const r = Senders.setAllGood(String(args.id || ''), args.all_good);
        return r ? { changed: true, from: r.before.allGood || '', ...brief(r.sender) } : { error: 'No sender with that id. Call list_senders for ids.' };
    }, opts);

    AgentTools.register({ type: 'function', function: {
        name: 'move_to_sender',
        description: 'Put one item (a tracked item from mail and texts, id "matter:…", or a commitment id) into a sender, when the user says it belongs there. It stays there; nenva will not move it again on its own.',
        parameters: { type: 'object', properties: {
            item: { type: 'string', description: 'The item id: a tracked item\'s id ("matter:…") or a commitment id' },
            sender: { type: 'string', description: 'The sender id (from list_senders)' }
        }, required: ['item', 'sender'] }
    }}, (args = {}) => {
        if (!ready()) return { error: 'Not available in this build.' };
        const key = keyOf(args.item);
        if (!titleOf(key)) return { error: 'No item with that id.' };
        const r = Senders.move(key, String(args.sender || ''), { by: 'you' });
        return r ? { moved: true, item: titleOf(key), into: nameOf(args.sender) } : { error: 'No sender with that id. Call list_senders for ids.' };
    }, { ...opts, ask: true, describe: (a) => `Put <b>${esc(titleOf(keyOf(a.item)) || 'that item')}</b> in <b>${esc(nameOf(a.sender))}</b>` });

    AgentTools.register({ type: 'function', function: {
        name: 'fold_senders',
        description: 'Fold one sender into another when the user says they are one thing ("put the plumber together with Home repairs"). Everything in the first moves into the second; its thread joins the second\'s.',
        parameters: { type: 'object', properties: {
            from: { type: 'string', description: 'The sender that goes away' },
            into: { type: 'string', description: 'The sender that keeps everything' }
        }, required: ['from', 'into'] }
    }}, (args = {}) => {
        if (!ready()) return { error: 'Not available in this build.' };
        const into = nameOf(args.into);
        const r = Senders.fold(String(args.from || ''), String(args.into || ''));
        return r ? { folded: true, gone: r.gone.name, into } : { error: 'Those are not two different senders. Call list_senders for ids.' };
    }, { ...opts, ask: true, describe: (a) => `Fold <b>${esc(nameOf(a.from))}</b> into <b>${esc(nameOf(a.into))}</b>` });

    // The hand-off (docs/SENDERS.md "The nenva sender"): a general chat that
    // turned into work on one thing carries what it learned into that
    // thing's thread, as nenva's own note with a link back, and the answer
    // says so. The person's words are never moved; the note is nenva's.
    AgentTools.register({ type: 'function', function: {
        name: 'hand_off_to_sender',
        description: 'When a general conversation with the user turns into work on ONE thing nenva looks after (it has a sender, see list_senders), carry what was learned or decided into that thing\'s own thread so it is kept with the thing: a short note in your words (one to three sentences, the facts and decisions, no chit-chat). Then tell the user it is in that thread and link it as [name](anjadhe://sender/<id>). Use only in a general conversation, never in a thing\'s own thread.',
        parameters: { type: 'object', properties: {
            sender: { type: 'string', description: 'The sender id (from list_senders)' },
            note: { type: 'string', description: 'What to keep in that thread, in your words' }
        }, required: ['sender', 'note'] }
    }}, (args = {}, ctx = {}) => {
        if (!ready() || typeof AgentService === 'undefined' || typeof SimpleExperience === 'undefined') return { error: 'Not available in this build.' };
        const s = Senders.get(String(args.sender || ''));
        if (!s || s.builtIn) return { error: 'No sender with that id. Call list_senders for ids.' };
        const note = String(args.note || '').replace(/\s+/g, ' ').trim().slice(0, 600);
        if (!note) return { error: 'A note is needed.' };
        const from = ctx.convId ? (AgentService.conversations || []).find(c => c.id === ctx.convId) : null;
        if (from && (from.todayKey === s.id || from.private)) return { error: from.private ? 'Not from a private chat.' : 'This is already that thread.' };
        const { conv } = SimpleExperience._cardConv({ key: s.id, title: s.name });
        conv.texting = true;
        conv.messages.push({ role: 'assistant', content: note, timestamp: new Date().toISOString(),
            metadata: { handoff: { from: from ? from.id : null, title: from ? from.title || null : null } } });
        conv.updatedAt = new Date().toISOString();
        AgentService._saveConversations();
        return { handedOff: true, sender: s.name, link: `anjadhe://sender/${s.id}`, note: 'Kept in that thread. Tell the user, with the link.' };
    }, opts);

    // What the person told nenva about a thing (M5): kept on its sender, read
    // with get_sender, removable on its info page. Words only, no ask.
    AgentTools.register({ type: 'function', function: {
        name: 'remember_about_sender',
        description: 'Keep a lasting fact the user told you about one thing nenva looks after, ON that thing (not in memory): a policy or account number, the agent or office and how to reach them, what it covers, what they pay, a decision they made about it. Use it when they tell you such a fact outside that thing\'s own thread (in its thread it is kept for you). One short sentence; "subject" (1-3 words) replaces an earlier fact with the same subject.',
        parameters: { type: 'object', properties: {
            sender: { type: 'string', description: 'The sender id (from list_senders)' },
            fact: { type: 'string' }, subject: { type: 'string' }
        }, required: ['sender', 'fact'] }
    }}, (args = {}, ctx = {}) => {
        if (!ready()) return { error: 'Not available in this build.' };
        const s = Senders.get(String(args.sender || ''));
        if (!s || s.builtIn) return { error: 'No sender with that id. Call list_senders for ids.' };
        const r = Senders.keepFact(s.id, { text: args.fact, subject: args.subject || '', convId: ctx.convId || null });
        return r ? { kept: true, on: s.name, status: r.status, fact: r.fact.text, replaced: r.before ? r.before.text : undefined } : { error: 'A fact is needed.' };
    }, opts);

    AgentTools.register({ type: 'function', function: {
        name: 'forget_sender_fact',
        description: 'Remove one fact kept on a thing nenva looks after, when the user says it is wrong or no longer true. Ids come from get_sender (youToldNenva).',
        parameters: { type: 'object', properties: { sender: { type: 'string' }, fact_id: { type: 'string' } }, required: ['sender', 'fact_id'] }
    }}, (args = {}) => {
        if (!ready()) return { error: 'Not available in this build.' };
        const gone = Senders.forgetFact(String(args.sender || ''), String(args.fact_id || ''));
        return gone ? { removed: true, fact: gone.text, from: nameOf(args.sender) } : { error: 'No such fact on that sender. Call get_sender for ids.' };
    }, opts);

    // Documents and routines about a thing (M8): linked to its sender, kept
    // in their own stores. A linked routine's news shows in the thing's
    // thread; a document is read with the thing (get_sender lists it).
    const linkTitle = async (kind, ref) => {
        if (kind === 'routine') { const r = typeof NotePrompts !== 'undefined' ? NotePrompts.get(ref) : null; return r ? (r.title || 'Routine') : null; }
        try {
            const listing = typeof window !== 'undefined' && window.electronLibrary ? await window.electronLibrary.list() : null;
            const d = listing && (listing.docs || []).find(x => x.id === ref);
            return d ? (d.title || 'Document') : null;
        } catch { return null; }
    };
    AgentTools.register({ type: 'function', function: {
        name: 'attach_to_sender',
        description: 'Attach a document (from list_documents, its docId) or a routine (from list_routines, its id) to one thing nenva looks after, when the user says it is about that thing ("keep my policy PDF with my car insurance", "that weekly price check is about my auto insurance"). A document is then read with the thing; a routine\'s news shows in the thing\'s thread. One thing per document or routine: attaching moves it.',
        parameters: { type: 'object', properties: {
            sender: { type: 'string', description: 'The sender id (from list_senders)' },
            kind: { type: 'string', enum: ['document', 'routine'] },
            id: { type: 'string', description: 'The document\'s docId or the routine\'s id' }
        }, required: ['sender', 'kind', 'id'] }
    }}, async (args = {}) => {
        if (!ready()) return { error: 'Not available in this build.' };
        const s = Senders.get(String(args.sender || ''));
        if (!s || s.builtIn) return { error: 'No sender with that id. Call list_senders for ids.' };
        const kind = args.kind === 'routine' ? 'routine' : args.kind === 'document' ? 'doc' : null;
        if (!kind) return { error: '"kind" is document or routine.' };
        const ref = String(args.id || '').trim();
        const title = await linkTitle(kind, ref);
        if (!title) return { error: kind === 'doc' ? 'No document with that docId. Call list_documents.' : 'No routine with that id. Call list_routines.' };
        const before = Senders.holderOf(kind, ref);
        const r = Senders.link(s.id, { kind, ref, title });
        return r ? { attached: true, what: title, to: s.name, ...(before && before !== s.id ? { movedFrom: nameOf(before) } : {}) } : { error: 'Could not attach it.' };
    }, { ...opts, ask: true, describe: (a) => `Keep <b>${esc(a.kind === 'routine' ? 'this routine' : 'this document')}</b> with <b>${esc(nameOf(a.sender))}</b>` });

    AgentTools.register({ type: 'function', function: {
        name: 'detach_from_sender',
        description: 'Detach a document or a routine from a thing nenva looks after, when the user says it is not about it.',
        parameters: { type: 'object', properties: { sender: { type: 'string' }, kind: { type: 'string', enum: ['document', 'routine'] }, id: { type: 'string' } }, required: ['sender', 'kind', 'id'] }
    }}, (args = {}) => {
        if (!ready()) return { error: 'Not available in this build.' };
        const kind = args.kind === 'routine' ? 'routine' : 'doc';
        const gone = Senders.unlink(String(args.sender || ''), kind, String(args.id || ''));
        return gone ? { detached: true, what: gone.title, from: nameOf(args.sender) } : { error: 'That is not attached to that sender. Call get_sender.' };
    }, opts);

    AgentTools.register({ type: 'function', function: {
        name: 'archive_sender',
        description: 'Archive a sender that has ended (the classes stopped, the car was sold): its thread and history are kept and searchable, and nenva stops looking at it. unarchive: true brings it back.',
        parameters: { type: 'object', properties: { id: { type: 'string' }, unarchive: { type: 'boolean' } }, required: ['id'] }
    }}, (args = {}) => {
        if (!ready()) return { error: 'Not available in this build.' };
        const r = args.unarchive ? Senders.unarchive(String(args.id || '')) : Senders.archive(String(args.id || ''));
        return r ? { [args.unarchive ? 'unarchived' : 'archived']: true, ...brief(r.sender) } : { error: 'No sender with that id. Call list_senders for ids.' };
    }, { ...opts, ask: true, describe: (a) => `${a.unarchive ? 'Bring back' : 'Archive'} <b>${esc(nameOf(a.id))}</b>` });
})();
