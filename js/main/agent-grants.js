/**
 * Standing permission grants, decided in main (2026-10-12, the architecture
 * review). The renderer keeps a copy for its own checks and sends it back
 * after a revoke, a bounds edit or a counted use; main keeps only what that
 * copy may change:
 *
 *   G1  A grant main does not hold is never created from the renderer's
 *       list. New standing grants come from main's own dialog.
 *   G2  What a grant covers (tool, scope, exclusions, createdAt) is main's.
 *   G3  Removing a grant is always kept.
 *   G4  A use count only moves forward within a day.
 *   G5  Tightening a bound (adding or lowering a daily limit, adding or
 *       bringing in an end date) is kept; loosening one is returned apart
 *       so main can ask before keeping it.
 */
'use strict';

function _budget(v) {
    const n = parseInt(v, 10);
    return n > 0 ? n : 0;
}

function _end(v) {
    return v && !isNaN(Date.parse(v)) ? String(v) : null;
}

/**
 * @returns {{ next: object[], loosened: { before: object, after: object }[] }}
 *   `next` holds what may be kept now; each loosened pair is kept as
 *   `after` only if the person confirms, else as `before`.
 */
function mergeGrants(stored, incoming, today = new Date().toISOString().slice(0, 10)) {
    const byId = new Map((Array.isArray(incoming) ? incoming : []).filter(g => g && g.id).map(g => [g.id, g]));
    const next = [];
    const loosened = [];
    for (const g of (Array.isArray(stored) ? stored : [])) {
        if (!g || !byId.has(g.id)) continue; // G3
        const inc = byId.get(g.id);
        const out = { ...g }; // G2
        if (typeof inc.usedDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(inc.usedDay)
            && inc.usedDay >= (g.usedDay || '') && inc.usedDay <= today) { // G4
            out.usedDay = inc.usedDay;
            out.usedCount = Math.max(inc.usedDay === g.usedDay ? (g.usedCount || 0) : 0, Number(inc.usedCount) || 0);
        }
        const incBudget = _budget(inc.budget), oldBudget = _budget(g.budget);
        const incEnd = _end(inc.expiresAt), oldEnd = _end(g.expiresAt);
        if (incBudget) out.budget = incBudget;
        else { delete out.budget; delete out.usedDay; delete out.usedCount; }
        if (incEnd) out.expiresAt = incEnd; else delete out.expiresAt;
        const looser = (oldBudget > 0 && (incBudget === 0 || incBudget > oldBudget))
            || (oldEnd && (!incEnd || Date.parse(incEnd) > Date.parse(oldEnd)));
        if (looser) loosened.push({ before: g, after: out }); // G5
        else next.push(out);
    }
    return { next, loosened };
}

/** What a grant covers, in words, from the key alone: never from a label
 *  the renderer supplies, which is what main's dialog guards against. */
function grantLabel(tool, scope) {
    const t = String(tool || '');
    const clip = (v, n) => String(v).slice(0, n);
    if (scope) {
        if (t === 'shell') return `Run this command: ${clip(scope, 200)}`;
        if (t === 'fs:write') return `Change files in ${clip(scope, 200)}`;
        if (t === 'fs:read') return `Read files in ${clip(scope, 200)}`;
        return `${t}: ${clip(scope, 200)}`;
    }
    const m = t.match(/^([a-z_]+):(.+)$/);
    if (m && m[1] === 'read_url') return `Read pages on ${clip(m[2], 120)}`;
    if (m && m[1] === 'mcp') return `Use the tool server "${clip(m[2], 80)}"`;
    if (m && m[1] === 'run_shortcut') return `Run your Shortcut "${clip(m[2], 80)}"`;
    const words = {
        send_email: 'Send email from your account to people already in your mail',
        send_text: 'Send texts to your own number',
        run_applescript: 'Run AppleScript that controls other apps',
        fs_trash: 'Move files to the Trash'
    };
    return words[t] || `Use the assistant tool "${clip(t, 80)}"`;
}

/** A new standing grant for a named tool, with the exclusions a standing
 *  send starts with (known recipients only, own number only). */
function newToolGrant(tool, now = new Date()) {
    const grant = { id: 'perm_' + now.getTime() + '_' + Math.random().toString(36).slice(2, 6), tool, createdAt: now.toISOString() };
    if (tool === 'send_email') grant.exclusions = ['new_recipient'];
    if (tool === 'send_text') grant.exclusions = ['other_people'];
    return grant;
}

module.exports = { mergeGrants, grantLabel, newToolGrant };
