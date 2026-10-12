'use strict';
// Shared validated record operations. Hosts supply only load/save and post-commit effects.
const SenderRecords = Object.freeze({
    RECENT_DAYS: 90,
    SHOW_MAX: 40,
    TRIES_MAX: 3,
    _t(v) { const t = Date.parse(v || 0); return isNaN(t) ? 0 : t; },
    _nums(s) { return (String(s || '').match(/\d+(?:\.\d+)?/g) || []).map(n => String(Number(n))); },
    /**
     * The things that can be placed, as items for the judgment. Pure over its
     * arguments. `placed(key)` says whether a key already has a sender
     * (directly or inherited); those are left out.
     */
    eligible(matters = [], commitments = [], placed = () => false, now = Date.now()) {
        const since = now - this.RECENT_DAYS * 86400000;
        const out = [];
        for (const m of matters) {
            if (!m || !m.id || (m.privacySources || []).includes('slack') || (m.sources || []).some(s => s.kind === 'slack')) continue;
            if (m.state !== 'open' && this._t(m.updatedAt) < since) continue;
            if (placed(m.id)) continue;
            const srcs = m.sources || [];
            const last = srcs[srcs.length - 1] || {};
            const when = m.when && m.when.date ? ` on ${m.when.date}` : '';
            out.push({ key: m.id, kind: 'matter', at: this._t(m.updatedAt || m.createdAt),
                text: `(${m.kind || 'other'}${m.state && m.state !== 'open' ? `, ${m.state}` : ''}) ${m.title || 'Untitled'}${m.status ? ` — ${m.status}` : ''}${when}${last.from ? ` — from ${last.from}` : ''}${last.summary ? `: "${String(last.summary).slice(0, 140)}"` : ''}` });
        }
        for (const c of commitments) {
            if (!c || !c.id || c.parent || c.state !== 'open') continue;
            if ((c.privacySources || []).includes('slack') || (c.origin && ['plan', 'matter'].includes(c.origin.kind))) continue;
            const key = `task:${c.id}`;
            if (placed(key)) continue;
            const shape = c.shape === 'goal' || c.outcome ? 'goal' : c.repeat && c.repeat.rule && c.repeat.rule !== 'none' ? `repeats ${c.repeat.rule}` : 'to-do';
            const when = c.when && c.when.date ? ` — ${c.when.date}` : c.by ? ` — by ${c.by}` : '';
            const note = c.note ? `: "${String(c.note).replace(/\s+/g, ' ').slice(0, 120)}"` : '';
            out.push({ key, kind: 'commitment', at: this._t(c.updatedAt || c.createdAt),
                text: `(their ${shape}${c.domain ? `, ${c.domain}` : ''}) ${c.title || 'Untitled'}${when}${note}` });
        }
        return out.sort((a, b) => b.at - a.at);
    },
    /** The senders to show the judgment: active ones, the busiest and newest first. Pure. */
    shown(data, titlesOf = () => [], max = this.SHOW_MAX) {
        return Object.values(data.senders || {}).filter(s => s.state !== 'archived')
            .sort((a, b) => this._t(b.updatedAt) - this._t(a.updatedAt)).slice(0, max)
            .map(s => ({ id: s.id, name: s.name, allGood: s.allGood || '', holds: titlesOf(s.id).slice(0, 4) }));
    },
    prompt(items, shown, now = Date.now()) {
        const today = new Date(now).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const kinds = typeof SenderKinds !== 'undefined' ? SenderKinds.SIZE : '';
        return `Today is ${today}.

${kinds}

THE SENDERS YOU ALREADY KEEP
${shown.length ? shown.map(s => `- ${s.name}${s.allGood ? ` — all good: ${s.allGood}` : ''}${s.holds.length ? ` — holds: ${s.holds.map(h => `"${h}"`).join(', ')}` : ''}`).join('\n') : '(none yet)'}

THINGS TO PLACE (mail and texts you filed for them, and things they said they would do)
${items.map((it, i) => `[I${i + 1}] ${it.text}`).join('\n')}

Place EVERY item in exactly one sender: one you already keep, if the item serves that sender's "all good", else a new one. Several items in this list may belong in the same new sender: give them exactly the same name. Name a new sender the way the person would say it ("Auto insurance", "Maya's music classes", "Your dental"), never after one event in it ("October water bill" is wrong, "Utilities" is right), never after a whole area of life ("School", "Health", "Finances", "Home", "Shopping" are too big). A one-off thing from their mail with nothing else like it (one order, one repair) gets a sender of its OWN, named after it ("Running shoes order", "Dishwasher repair"); never put unrelated one-offs together. A small to-do of theirs ("their to-do") that serves no sender you keep and none of the new ones goes in "Reminders", their list of small things to do; never make a sender for one to-do. Money owed to a place and events at that place serve different "all good"s: two senders. For a new sender, write "all_good": one plain sentence about the THING (what it looks like when nothing about it needs them), never about one event, with no dates or numbers.
Answer JSON only, one entry per item. "sender" is the EXACT name of a sender you already keep, or the name of a new one; give "all_good" only for a new one:
{"placements": [{"item": "I1", "sender": "Auto insurance", "all_good": "Covered, paid, the renewal never missed and the price still fair."}, {"item": "I2", "sender": "Auto insurance"}, {"item": "I3", "sender": "Your dental"}]}`;
    },
    /**
     * Keep what the assistant said only where it is checkable. Pure.
     * Returns [{ key, sender }] for existing senders and [{ key, new: { name, allGood } }]
     * for new ones; "new" answers with one name (case and punctuation aside) are one sender,
     * and a "new" name that IS a shown sender's name joins that sender.
     */
    vet(raw, items, shown) {
        const list = raw && Array.isArray(raw.placements) ? raw.placements : [];
        const known = new Set(items.flatMap(it => this._nums(it.text)));
        const okText = (s, max) => { const v = this._clean(s, max); return v && this._nums(v).every(n => known.has(n)) ? v : ''; };
        const byName = new Map(shown.map(s => [this._norm(s.name), s.id]));
        const seen = new Set();
        const out = [];
        for (const p of list) {
            if (!p || typeof p !== 'object') continue;
            const im = /^I(\d+)$/i.exec(String(p.item || '').replace(/[^a-z0-9]/gi, ''));
            const it = im ? items[Number(im[1]) - 1] : null;
            if (!it || seen.has(it.key)) continue;
            const sm = /^S(\d+)$/i.exec(String(p.sender || '').replace(/[^a-z0-9]/gi, ''));
            if (sm) {
                const s = shown[Number(sm[1]) - 1];
                if (!s) continue;
                seen.add(it.key); out.push({ key: it.key, sender: s.id });
                continue;
            }
            // A name however it was given: a small model writes it in "sender" or "name" as often as in "new".
            const given = [p.new, p.name, p.sender].find(v => typeof v === 'string' && v.trim() && !/^(new|[IS]\s*\d+)$/i.test(v.replace(/[^a-z0-9 ]/gi, '').trim()));
            const name = okText(given, this.NAME_MAX);
            if (!name) continue;
            // A to-do with no home: Reminders holds it (never a matter, never a sender named after it).
            if (this._norm(name) === 'reminders' && it.kind === 'commitment' && !byName.has('reminders')) { seen.add(it.key); out.push({ key: it.key, reminders: true }); continue; }
            const same = byName.get(this._norm(name));
            seen.add(it.key);
            if (same) out.push({ key: it.key, sender: same });
            else out.push({ key: it.key, new: { name, allGood: okText(p.all_good, this.ALL_GOOD_MAX) } });
        }
        return out;
    },
    /**
     * Fold checked placements into `data`. Pure over `data`. New senders with
     * one name (normalised) in a batch become one. Returns { created: [ids] }.
     * Never overrides a placement the person made (`by: 'you'`).
     */
    apply(data, placements, now = Date.now(), by = 'nenva') {
        const iso = new Date(now).toISOString();
        const fresh = new Map();
        const created = [];
        for (const p of placements) {
            const had = data.place[p.key];
            if (had && had.by === 'you') continue;
            // Reminders holds it by its shape; asking again would only ask the same.
            if (p.reminders) { data.tries[p.key] = this.TRIES_MAX; continue; }
            let id = p.sender ? this.resolve(data, p.sender) : null;
            if (!id && p.new) {
                const k = this._norm(p.new.name);
                id = fresh.get(k);
                if (!id) {
                    id = this._id(p.new.name, now);
                    data.senders[id] = { id, name: p.new.name, allGood: p.new.allGood || '', state: 'active', confirmed: by === 'you',
                        by, createdAt: iso, updatedAt: iso };
                    fresh.set(k, id);
                    created.push(id);
                }
            }
            if (!id || !data.senders[id]) continue;
            data.place[p.key] = { sender: id, by, at: iso };
            data.senders[id].updatedAt = iso;
            delete data.tries[p.key];
        }
        return { created };
    },
    ALL_GOOD_MAX: 200,
    FACTS_MAX: 40,
    NAME_MAX: 40,
    _clean(s, max) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max); },
    _norm(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); },
    _id(name, now = Date.now()) {
        const slug = this._norm(name).replace(/ /g, '-').slice(0, 24) || 'thing';
        return `sender:${slug}-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    },
    /** Start a sender by name ("start keeping track of Maya's music classes"). */
    create(name, allGood = '', { by = 'you', now = Date.now() } = {}) {
        name = this._clean(name, this.NAME_MAX);
        if (!name) return null;
        const d = this._load();
        const same = Object.values(d.senders).find(s => s.state !== 'archived' && this._norm(s.name) === this._norm(name));
        if (same) return same;
        const iso = new Date(now).toISOString();
        const id = this._id(name, now);
        d.senders[id] = { id, name, allGood: this._clean(allGood, this.ALL_GOOD_MAX), state: 'active', confirmed: by === 'you', by, createdAt: iso, updatedAt: iso };
        this._save();
        return d.senders[id];
    },
    _edit(id, fn) {
        const d = this._load();
        const s = d.senders[this.resolve(d, id)];
        if (!s) return null;
        const before = JSON.parse(JSON.stringify(s));
        fn(s);
        s.updatedAt = new Date().toISOString();
        this._save();
        return { sender: s, before };
    },
    confirm(id) { return this._edit(id, s => { s.confirmed = true; }); },
    rename(id, name) {
        name = this._clean(name, this.NAME_MAX);
        return name ? this._edit(id, s => { s.name = name; s.confirmed = true; }) : null;
    },
    setAllGood(id, sentence) { return this._edit(id, s => { s.allGood = this._clean(sentence, this.ALL_GOOD_MAX); }); },
    archive(id) { return this._edit(id, s => { s.state = 'archived'; s.archivedAt = new Date().toISOString(); }); },
    unarchive(id) { return this._edit(id, s => { s.state = 'active'; delete s.archivedAt; }); },
    /** Put a thing in a sender on the person's word; never re-judged after. Returns the previous placement (for Undo). */
    move(key, senderId, { by = 'you' } = {}) {
        const d = this._load();
        const id = this.resolve(d, senderId);
        if (!d.senders[id]) return null;
        const before = d.place[key] ? { ...d.place[key] } : null;
        d.place[key] = { sender: id, by, at: new Date().toISOString() };
        d.senders[id].updatedAt = d.place[key].at;
        d.senders[id].confirmed = true;
        this._save();
        return { before };
    },
    unmove(key, before) {
        const d = this._load();
        if (before) d.place[key] = before; else delete d.place[key];
        this._save();
    },
    /** Two senders that are one thing: `fromId` folds into `intoId`, its id stays an alias (S5, S7). */
    fold(fromId, intoId) {
        const d = this._load();
        const from = this.resolve(d, fromId), into = this.resolve(d, intoId);
        if (from === into || !d.senders[from] || !d.senders[into]) return null;
        const gone = d.senders[from];
        d.aliases[from] = into;
        delete d.senders[from];
        d.senders[into].updatedAt = new Date().toISOString();
        d.senders[into].confirmed = true;
        d.folded = d.folded || {};
        d.folded[from] = { sender: gone, into, at: d.senders[into].updatedAt };
        // What the person told nenva about it goes with it (M5); unfold takes those back.
        if ((gone.links || []).length) d.senders[into].links = [...(d.senders[into].links || []), ...gone.links.filter(l => !(d.senders[into].links || []).some(x => x.kind === l.kind && x.ref === l.ref)).map(l => ({ ...l, foldedFrom: from }))];
        if ((gone.facts || []).length) d.senders[into].facts = [...(d.senders[into].facts || []), ...gone.facts.map(f => ({ ...f, foldedFrom: from }))].slice(-this.FACTS_MAX);
        this._save();
        return { gone };
    },
    unfold(fromId) {
        const d = this._load();
        const rec = d.folded && d.folded[fromId];
        if (!rec) return false;
        d.senders[fromId] = rec.sender;
        const into = d.senders[rec.into];
        if (into && into.facts) into.facts = into.facts.filter(f => f.foldedFrom !== fromId);
        if (into && into.links) into.links = into.links.filter(l => l.foldedFrom !== fromId);
        delete d.aliases[fromId];
        delete d.folded[fromId];
        this._save();
        return true;
    },
});
if (typeof module !== 'undefined' && module.exports) module.exports = SenderRecords;
