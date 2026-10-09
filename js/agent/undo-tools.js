/**
 * Undo tools — "undo that" said in a chat does what the Undo buttons do
 * (2026-10-08, docs/AI_NATIVE.md parity inventory, batch 2). Before this
 * the assistant could only reverse a change by hand, re-writing the old
 * values it remembered, which is how a reverse goes wrong.
 *
 * Two ledgers already hold every undoable change, and both are used as is:
 *   - a chat TURN's writes: WriteLedger scopes, linked from the answer's
 *     `metadata.undoScope` (the "Undo this turn" button). undoScope restores
 *     pre-images, skips anything changed since and says what it cannot take
 *     back (an email sent, a calendar event made elsewhere).
 *   - a COMMITMENT's changes from anywhere (a tap, a receipt under an
 *     answer, a capture): Commitments' ledger (the toasts' and receipts'
 *     Undo). Commitments.undo refuses when the same thing changed again.
 *
 * list_recent_changes reads both; undo_change asks every time (the consent
 * dialog names what goes back) and its own writes are recorded in the
 * current turn, so an undo can itself be undone. Blocked in untrusted turns.
 */
(() => {
    if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function') return;

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const clean = (s, n = 120) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
    const OPS = { create: 'added', change: 'changed', remove: 'removed', done: 'marked done', dropped: 'dropped', report: 'noted on a day', 'move-day': 'moved one day', reopen: 'reopened' };

    const convOf = (id) => {
        if (!id || typeof AgentService === 'undefined') return null;
        return (AgentService.conversations || []).find(c => c && c.id === id) || null;
    };

    /** This chat's turns that still have something to undo, newest first. */
    const turns = (convId) => {
        if (typeof WriteLedger === 'undefined') return [];
        const conv = convOf(convId);
        if (!conv) return [];
        const out = [];
        for (const m of [...(conv.messages || [])].reverse()) {
            const id = m && m.metadata && m.metadata.undoScope;
            if (!id || out.some(t => t.id === id) || !WriteLedger.undoPreview(id)) continue;
            const s = WriteLedger.getScope(id);
            if (!s) continue;
            out.push({ id, at: s.at, asked: clean(s.label), changed: (s.entries || []).filter(e => !e.external).slice(0, 8).map(e => clean(`${e.action || e.tool}${e.target ? ` ${e.target}` : ''}`, 80)),
                cannotUndo: (s.entries || []).filter(e => e.external).map(e => clean(`${e.tool}${e.target ? ` (${e.target})` : ''}`, 80)) });
            if (out.length >= 5) break;
        }
        return out;
    };

    /** The commitment changes that can still be undone, newest first. */
    const commitmentChanges = () => {
        if (typeof Commitments === 'undefined' || !Commitments._load) return [];
        let d; try { d = Commitments._load(); } catch { return []; }
        const ledger = (d && d.ledger) || [];
        const out = [];
        for (let i = ledger.length - 1; i >= 0 && out.length < 10; i--) {
            const e = ledger[i];
            if (!e || e.undone || !e.id || !OPS[e.op]) continue;
            if (ledger.slice(i + 1).some(x => x.target === e.target && !x.undone)) continue;   // changed again since
            const c = d.items && d.items[e.target];
            const title = (c && c.title) || (e.before && e.before.title) || (e.after && e.after.title) || e.target;
            out.push({ id: e.id, at: e.at, what: `${clean(title, 80)}: ${OPS[e.op]}`, by: e.by || undefined, why: clean(e.why) || undefined });
        }
        return out;
    };

    AgentTools.register({ type: 'function', function: {
        name: 'list_recent_changes',
        description: 'What can still be undone: this chat\'s earlier turns that changed something (ref "turn:<id>"), and the latest changes to commitments from anywhere, a tap, a receipt or a chat (ref "commitment:<id>"). Call it when the person says "undo that", "put it back", "I didn\'t mean that", then undo_change the one they mean.',
        parameters: { type: 'object', properties: {} }
    }}, (a = {}, ctx = {}) => {
        const t = turns(ctx.convId), c = commitmentChanges();
        const out = {
            turns: t.map(x => ({ ref: `turn:${x.id}`, at: x.at, asked: x.asked, changed: x.changed, cannotUndo: x.cannotUndo.length ? x.cannotUndo : undefined })),
            commitments: c.map(x => ({ ref: `commitment:${x.id}`, at: x.at, what: x.what, by: x.by, why: x.why }))
        };
        if (!t.length && !c.length) out.note = 'Nothing here can be undone.';
        return out;
    }, { group: 'undo', readOnly: true, blockUntrusted: true });

    AgentTools.register({ type: 'function', function: {
        name: 'undo_change',
        description: 'Undo one change from list_recent_changes, by its ref. A turn puts back everything that turn changed in nenva (what was changed since is kept, and what left the Mac, like an email sent, cannot come back; the result says so). A commitment change puts that one change back. Always asks the person first.',
        parameters: { type: 'object', properties: {
            ref: { type: 'string', description: 'A ref from list_recent_changes: "turn:<id>" or "commitment:<id>"' }
        }, required: ['ref'] }
    }}, async (a = {}, ctx = {}) => {
        const ref = String(a.ref || '');
        const [kind, id] = [ref.split(':')[0], ref.slice(ref.indexOf(':') + 1)];
        if (kind === 'turn') {
            if (typeof WriteLedger === 'undefined') return { error: 'Undo is not available.' };
            if (!turns(ctx.convId).some(t => t.id === id)) return { error: 'That turn is not one of this chat\'s undoable turns. Call list_recent_changes.' };
            const r = await WriteLedger.undoScope(id);
            if (r.error) return { error: r.error };
            return { success: true, restored: r.restoredKeys, filesPutBack: r.restoredFiles.length || undefined,
                keptBecauseChangedSince: r.conflictKeys.length ? r.conflictKeys : undefined,
                cannotUndo: r.external.length ? r.external : undefined,
                filesNotRestored: r.failedFiles.length ? r.failedFiles : undefined };
        }
        if (kind === 'commitment') {
            if (typeof Commitments === 'undefined') return { error: 'Undo is not available.' };
            if (!commitmentChanges().some(x => x.id === id)) return { error: 'That change cannot be undone now (it was undone already, or changed again since). Call list_recent_changes.' };
            const r = Commitments.undo(id);
            if (!r.ok) return { error: r.error };
            if (typeof SimpleExperience !== 'undefined' && SimpleExperience.render) { try { SimpleExperience.render(); } catch { /* the undo holds */ } }
            return { success: true, id: r.id };
        }
        return { error: 'ref must be "turn:<id>" or "commitment:<id>" from list_recent_changes.' };
    }, { group: 'undo', ask: true, blockUntrusted: true, describe: (a = {}) => {
        const ref = String(a.ref || '');
        const id = ref.slice(ref.indexOf(':') + 1);
        if (ref.startsWith('commitment:')) {
            const x = commitmentChanges().find(c => c.id === id);
            return x ? `Undo <b>${esc(x.what)}</b>` : 'Undo a change to a commitment';
        }
        const s = typeof WriteLedger !== 'undefined' ? WriteLedger.getScope(id) : null;
        return s ? `Undo what nenva changed when you asked <b>“${esc(clean(s.label, 80))}”</b>` : 'Undo an earlier turn';
    } });

    AgentTools.GROUP_INFO.undo = 'undo a change: what an earlier turn changed, or a change to a commitment ("undo that", "put it back")';
})();
