/**
 * ContentFiles — Notes and Journal as Markdown files in ~/Anjadhe/
 * (docs/CONTENT_FILES.md, decided 2026-08-26).
 *
 * "Your notes are files you can open in Finder." Phase 1+2 of that promise:
 * the store blob (`app_notes`, `app_journal`) STAYS canonical and stays the
 * sync transport — record-merge, tombstones, the encrypted journal all keep
 * working untouched — and this module keeps a Markdown PROJECTION of every
 * record in ~/Anjadhe/Notes/ and ~/Anjadhe/Journal/, then imports edits
 * made to those files from outside (Obsidian, any editor) back into the
 * store. Phase 3 (files canonical) is deliberately not built yet.
 *
 * Laws:
 *  - The store is written through the app's own paths only. Inbound edits
 *    become ordinary record updates (with a fresh modifiedAt), so sync and
 *    every reader see them as edits made here.
 *  - The record id is the identity; the filename is derived from the title
 *    (or date) and may change. Frontmatter `id` is the join key, so a file
 *    renamed in Obsidian is the same note.
 *  - Conflict rule is AppleImport's: an outside edit wins when the file is
 *    newer than the record's modifiedAt; otherwise the app's copy wins and
 *    the file is rewritten. Our OWN writes are recognised by content hash
 *    (`state[kind][id].hash`), never by timestamp.
 *  - Deletions travel both ways, guarded: a folder that suddenly has no
 *    files at all is treated as LOST (rewritten), never as "delete all".
 *  - The Mac is the only writer the app knows about; nothing on a phone
 *    touches this folder (the relay-through-Mac law in the plan).
 *
 * Pure helpers (frontmatter, slugs, hash, planning) are Node-exported and
 * pinned by tests/content-files-test.js.
 */
const ContentFiles = {
    STATE_KEY: 'content-files-state',
    KINDS: ['notes', 'journal'],
    IMG_TOKEN: 'ANJIMGTOKEN',

    _enabled: false,
    _state: null,
    _timers: {},
    _busy: {},
    _queued: {},
    _bound: false,

    // ── lifecycle ─────────────────────────────────────────────────────────

    /** From AppManager.init (never a view). No-op without the bridge or when off. */
    async init() {
        if (typeof window === 'undefined' || !window.electronContentFiles) return;
        let info = null;
        try { info = await window.electronContentFiles.getEnabled(); } catch { return; }
        this._enabled = !!(info && info.enabled);
        this.root = info && info.root;
        if (!this._enabled) return;
        if (!this._bound) {
            this._bound = true;
            window.electronContentFiles.onChanged(({ kind, names }) => {
                if (!this._enabled || !this.KINDS.includes(kind)) return;
                this.syncIn(kind, names).catch(e => console.warn('[content-files] inbound failed:', e?.message));
            });
        }
        // Deferred past first paint; a full reconcile reads every file once.
        setTimeout(() => { this.reconcileAll().catch(e => console.warn('[content-files] reconcile failed:', e?.message)); }, 4000);
    },

    isEnabled() { return this._enabled; },

    async setEnabled(on) {
        if (!window.electronContentFiles) return false;
        const r = await window.electronContentFiles.setEnabled(!!on);
        this._enabled = !!(r && r.enabled);
        if (this._enabled) {
            if (!this._bound) await this.init();
            await this.reconcileAll();
        }
        return this._enabled;
    },

    async reconcileAll() {
        for (const kind of this.KINDS) {
            await this.syncIn(kind, null);
            await this.syncOut(kind);
        }
    },

    /** StorageManager.set hook — any writer of the notes/journal blob. */
    onKeyWritten(appName) {
        if (!this._enabled || !this.KINDS.includes(appName)) return;
        clearTimeout(this._timers[appName]);
        this._timers[appName] = setTimeout(() => {
            this.syncOut(appName).catch(e => console.warn('[content-files] outbound failed:', e?.message));
        }, 800);
    },

    // ── state ─────────────────────────────────────────────────────────────

    _loadState() {
        if (this._state) return this._state;
        try { this._state = JSON.parse(localStorage.getItem(this.STATE_KEY) || 'null'); } catch { this._state = null; }
        if (!this._state || typeof this._state !== 'object') this._state = {};
        for (const k of this.KINDS) if (!this._state[k] || typeof this._state[k] !== 'object') this._state[k] = {};
        return this._state;
    },
    _saveState() {
        try { localStorage.setItem(this.STATE_KEY, JSON.stringify(this._state || {})); } catch { /* quota */ }
    },

    // ── records ───────────────────────────────────────────────────────────

    _records(kind) {
        const d = StorageManager.get(kind);
        if (kind === 'notes') return Array.isArray(d?.notes) ? d.notes : [];
        return Array.isArray(d?.entries) ? d.entries : [];
    },

    /** Write records back through the same shape every other writer uses. */
    _writeRecords(kind, records, tombstones = null) {
        if (kind === 'notes') {
            StorageManager.set('notes', tombstones ? { notes: records, tombstones } : { notes: records });
            if (typeof NotesApp !== 'undefined' && Array.isArray(NotesApp.notes) && NotesApp.notes.length) {
                NotesApp.notes = records.map(n => ({ ...n }));
                if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'notes' && typeof NotesApp.render === 'function') {
                    try { NotesApp.render(); } catch { /* view not built yet */ }
                }
            }
        } else {
            StorageManager.set('journal', { entries: records });
            if (typeof JournalApp !== 'undefined' && Array.isArray(JournalApp.entries) && JournalApp.entries.length) {
                JournalApp.entries = records.map(e => ({ ...e }));
                if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'journal' && typeof JournalApp.render === 'function') {
                    try { JournalApp.render(); } catch { /* view not built yet */ }
                }
            }
        }
        if (typeof AppManager !== 'undefined' && typeof AppManager.updateStats === 'function') AppManager.updateStats();
    },

    // ── outbound: records → files ─────────────────────────────────────────

    async syncOut(kind) {
        if (!this._enabled || !window.electronContentFiles) return;
        if (this._busy[kind]) { this._queued[kind] = true; return; }
        this._busy[kind] = true;
        try {
            const state = this._loadState()[kind];
            const listing = await window.electronContentFiles.list(kind);
            if (!listing || listing.error) return;
            const present = new Set((listing.files || []).map(f => f.name));
            const records = this._records(kind);
            const ids = new Set();
            const taken = new Set(present);

            for (const rec of records) {
                if (!rec || !rec.id) continue;
                ids.add(rec.id);
                const st = state[rec.id];
                const upToDate = st && !st.needsHeader && st.modifiedAt === (rec.modifiedAt || rec.createdAt || '') && present.has(st.name);
                if (upToDate) continue;

                let name = st && st.name;
                const desired = ContentFiles.fileNameFor(kind, rec, taken, name, st && st.title);
                if (name && name !== desired && present.has(name)) {
                    const r = await window.electronContentFiles.rename(kind, name, desired);
                    if (!r || r.error) { /* keep the old name */ } else { present.delete(name); present.add(desired); name = desired; }
                } else {
                    name = desired;
                }
                taken.add(name);

                const { text, assets } = await this._serialize(kind, rec);
                for (const a of assets) {
                    try { await window.electronContentFiles.writeAsset(kind, a.name, a.dataUrl); } catch { /* asset best-effort */ }
                }
                const w = await window.electronContentFiles.write(kind, name, text);
                if (!w || w.error) { console.warn('[content-files] write failed:', name, w && w.error); continue; }
                state[rec.id] = { name, hash: ContentFiles.hash(text), modifiedAt: rec.modifiedAt || rec.createdAt || '', ...(kind === 'notes' ? { title: rec.title || '' } : {}) };
                present.add(name);
            }

            // Records gone from the store (deleted here or on another Mac) →
            // their files go too. Only files we know we wrote.
            for (const id of Object.keys(state)) {
                if (ids.has(id)) continue;
                const st = state[id];
                if (st && st.name && present.has(st.name)) {
                    await window.electronContentFiles.remove(kind, st.name);
                }
                delete state[id];
            }
            this._saveState();
        } finally {
            this._busy[kind] = false;
            if (this._queued[kind]) { this._queued[kind] = false; this.syncOut(kind).catch(() => {}); }
        }
    },

    /** Record → { text, assets:[{name,dataUrl}] }. */
    async _serialize(kind, rec) {
        const assets = [];
        const html = String(rec.content || '');
        const { html: tokenised, images } = this._extractImages(kind, rec, html);
        for (const im of images) if (im.dataUrl) assets.push({ name: im.name, dataUrl: im.dataUrl });
        let md = (typeof AgentTools !== 'undefined' && typeof AgentTools.noteHtmlToMd === 'function')
            ? AgentTools.noteHtmlToMd(tokenised)
            : ContentFiles.htmlToText(tokenised);
        md = md.replace(new RegExp(this.IMG_TOKEN + '(\\d+)', 'g'), (m, n) => {
            const im = images[+n];
            if (!im) return '';
            return im.video ? `[video](assets/${im.name})` : `![${im.alt || ''}](assets/${im.name})`;
        });

        const fm = kind === 'notes'
            ? {
                id: rec.id,
                title: rec.title || 'Untitled',
                created: rec.createdAt || '',
                modified: rec.modifiedAt || rec.createdAt || '',
                tags: Array.isArray(rec.tags) ? rec.tags : [],
                pinned: !!rec.pinned,
                anjadhe: ContentFiles._appOwned(kind, rec)
            }
            : {
                id: rec.id,
                date: rec.date || rec.createdAt || '',
                mood: rec.mood || 'neutral',
                tags: Array.isArray(rec.tags) ? rec.tags : [],
                created: rec.createdAt || '',
                modified: rec.modifiedAt || rec.createdAt || ''
            };
        const text = ContentFiles.frontmatterStringify(fm) + '\n' + md.trim() + '\n';
        return { text, assets };
    },

    /**
     * Pull every image/video out of the HTML into an asset list, leaving a
     * text token where each stood. Notes embed images as data: URLs; the
     * Journal keeps `<img|video data-media="id">` markers with bytes in
     * `journalMedia_<id>` keys.
     */
    _extractImages(kind, rec, html) {
        if (!/<(img|video)\b/i.test(html)) return { html, images: [] };
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const images = [];
        doc.querySelectorAll('img, video').forEach(el => {
            const idx = images.length;
            const isVideo = el.tagName.toLowerCase() === 'video';
            let dataUrl = null, name = null;
            const mediaId = el.getAttribute('data-media');
            if (mediaId) {
                const media = StorageManager.get(`journalMedia_${mediaId}`);
                dataUrl = media && media.data ? String(media.data) : null;
                const type = (media && media.type) || (isVideo ? 'video/mp4' : 'image/jpeg');
                name = `${ContentFiles.safeSegment(mediaId)}.${ContentFiles.extFor(type)}`;
            } else {
                const src = el.getAttribute('src') || '';
                if (/^data:/i.test(src)) {
                    dataUrl = src;
                    const type = (/^data:([^;,]+)/.exec(src) || [])[1] || 'image/png';
                    name = `${ContentFiles.safeSegment(rec.id)}-${idx + 1}.${ContentFiles.extFor(type)}`;
                } else if (src) {
                    // A remote image: keep the link, nothing to write.
                    const t = doc.createTextNode(`![${el.getAttribute('alt') || ''}](${src})`);
                    el.replaceWith(t);
                    return;
                } else {
                    el.remove();
                    return;
                }
            }
            images.push({ name, dataUrl, video: isVideo, alt: el.getAttribute('alt') || '' });
            const p = doc.createElement('p');
            p.textContent = `${this.IMG_TOKEN}${idx}`;
            el.replaceWith(p);
        });
        return { html: doc.body.innerHTML, images };
    },

    // ── inbound: files → records ──────────────────────────────────────────

    /**
     * `names`: the files the watcher saw change, or null for a full sweep.
     * A full sweep also handles renames and deletions.
     */
    async syncIn(kind, names) {
        if (!this._enabled || !window.electronContentFiles) return;
        if (this._busy[kind]) { this._queued[kind] = true; return; }
        this._busy[kind] = true;
        try {
            const state = this._loadState()[kind];
            const listing = await window.electronContentFiles.list(kind);
            if (!listing || listing.error) return;
            const files = listing.files || [];
            const byName = new Map(files.map(f => [f.name, f]));
            // A watched name that is no longer on disk is a deletion or a
            // rename; both need the whole picture, so escalate to a sweep.
            const full = !Array.isArray(names) || names.some(n => !byName.has(n));

            // Folder-loss guard: we wrote files before and now there are none.
            if (full && files.length === 0 && Object.keys(state).length > 0) {
                for (const id of Object.keys(state)) delete state[id];
                this._saveState();
                return; // syncOut will rewrite everything
            }

            const records = this._records(kind);
            const byId = new Map(records.map(r => [r.id, r]));
            const stateByName = new Map(Object.entries(state).map(([id, st]) => [st.name, id]));
            let changed = false;
            const tombstones = {};
            const seenIds = new Set();

            const targets = full ? files : names.map(n => byName.get(n)).filter(Boolean);
            for (const f of targets) {
                const r = await window.electronContentFiles.read(kind, f.name);
                if (!r || r.error) continue;
                const hash = ContentFiles.hash(r.text);
                const parsed = ContentFiles.frontmatterParse(r.text);
                let id = parsed.data.id ? String(parsed.data.id) : null;
                const knownId = stateByName.get(f.name);
                if (!id && knownId) id = knownId;
                if (id && seenIds.has(id)) continue; // a duplicate copy of a note — ignore it
                if (id) seenIds.add(id);

                const st = id ? state[id] : null;
                if (st && st.hash === hash) {
                    if (st.name !== f.name) { st.name = f.name; changed = true; } // renamed outside, same content
                    continue;
                }
                const rec = id ? byId.get(id) : null;
                const fileISO = new Date(r.mtimeMs || 0).toISOString();
                if (rec && st && (rec.modifiedAt || '') > fileISO) {
                    // App edited after the file: app wins; drop state so syncOut rewrites.
                    delete state[id];
                    changed = true;
                    continue;
                }
                if (kind === 'notes' && typeof NotesApp !== 'undefined' && rec && NotesApp.currentNoteId === rec.id && NotesApp.hasUnsavedChanges) {
                    continue; // never yank a note out from under an open editor; next sweep retries
                }
                const fields = await this._materialize(kind, parsed, f.name, fileISO, rec);
                if (rec) {
                    Object.assign(rec, fields);
                    rec.modifiedAt = fileISO;
                } else {
                    const created = {
                        id: id || UIUtils.generateId(),
                        ...(kind === 'notes'
                            ? { template: 'blank', bookNumbered: true, bookLayout: 'scroll', pinned: false }
                            : { mood: 'neutral' }),
                        ...fields,
                        createdAt: fields.createdAt || fileISO,
                        modifiedAt: fileISO
                    };
                    records.unshift(created);
                    byId.set(created.id, created);
                    id = created.id;
                }
                // A file without an id gets its frontmatter written once, so a
                // cleared state can never re-import it as a second note.
                state[id] = { name: f.name, hash, modifiedAt: fileISO, ...(kind === 'notes' ? { title: fields.title || '' } : {}), ...(parsed.data.id ? {} : { needsHeader: true }) };
                changed = true;
                if (kind === 'notes') this._ensureTags(fields.tags);
            }

            // Deletions (full sweep only): a file we wrote is gone and no
            // other file carries its id → the record goes too.
            if (full) {
                for (const [id, st] of Object.entries(state)) {
                    if (byName.has(st.name) || seenIds.has(id)) continue;
                    if (!byId.has(id)) { delete state[id]; continue; }
                    const idx = records.findIndex(x => x.id === id);
                    if (idx >= 0) {
                        records.splice(idx, 1);
                        tombstones[id] = new Date().toISOString();
                        if (kind === 'notes' && typeof LinkManager !== 'undefined') {
                            try { LinkManager.removeAllLinksForItem('notes', id); } catch { /* best effort */ }
                        }
                        changed = true;
                    }
                    delete state[id];
                }
            }

            if (changed) {
                const hasTomb = Object.keys(tombstones).length > 0;
                this._writeRecords(kind, records, hasTomb && kind === 'notes' ? tombstones : null);
                this._saveState();
            }
        } finally {
            this._busy[kind] = false;
            if (this._queued[kind]) { this._queued[kind] = false; this.syncIn(kind, null).catch(() => {}); }
        }
    },

    /** Parsed file → record fields (content back to the app's HTML). */
    async _materialize(kind, parsed, fileName, fileISO, existing) {
        const d = parsed.data;
        let md = parsed.body;
        // Image links back to assets → data: URLs. Tokenise before the md→html pass.
        const assets = [];
        md = md.replace(/!\[([^\]]*)\]\(assets\/([^)\s]+)\)|\[video\]\(assets\/([^)\s]+)\)/g, (m, alt, img, vid) => {
            const n = assets.length;
            assets.push({ name: decodeURIComponent(img || vid), video: !!vid, alt: alt || '' });
            return `${this.IMG_TOKEN}${n}`;
        });
        let html = (typeof AgentTools !== 'undefined' && typeof AgentTools.mdToNoteHtml === 'function')
            ? AgentTools.mdToNoteHtml(md)
            : ContentFiles.textToHtml(md);
        for (let i = 0; i < assets.length; i++) {
            const a = assets[i];
            let tag = '';
            if (kind === 'journal') {
                // Journal media lives in its own keys; the marker carries the id.
                const mediaId = a.name.replace(/\.[a-z0-9]+$/i, '');
                let media = StorageManager.get(`journalMedia_${mediaId}`);
                if (!media) {
                    const r = await window.electronContentFiles.readAsset(kind, a.name);
                    if (r && r.dataUrl) {
                        const type = (/^data:([^;,]+)/.exec(r.dataUrl) || [])[1] || 'image/jpeg';
                        StorageManager.set(`journalMedia_${mediaId}`, { id: mediaId, createdAt: fileISO, kind: a.video ? 'video' : 'image', type, data: r.dataUrl, thumb: null });
                        media = true;
                    }
                }
                tag = media ? (a.video ? `<video data-media="${mediaId}" controls></video>` : `<img data-media="${mediaId}">`) : '';
            } else {
                const r = await window.electronContentFiles.readAsset(kind, a.name);
                tag = r && r.dataUrl ? `<img src="${r.dataUrl}"${a.alt ? ` alt="${ContentFiles.escapeAttr(a.alt)}"` : ''}>` : '';
            }
            const tokenRx = new RegExp(`<p>\\s*${this.IMG_TOKEN}${i}\\s*</p>|${this.IMG_TOKEN}${i}`, 'g');
            html = html.replace(tokenRx, tag);
        }

        const tags = Array.isArray(d.tags) ? d.tags.map(t => String(t).replace(/^#/, '').trim()).filter(Boolean)
            : (typeof d.tags === 'string' && d.tags.trim() ? d.tags.split(/[,\s]+/).map(t => t.replace(/^#/, '')).filter(Boolean) : (existing ? existing.tags || [] : []));
        if (kind === 'notes') {
            const title = (d.title && String(d.title).trim())
                || (/^#\s+(.+)$/m.exec(parsed.body) || [])[1]
                || fileName.replace(/\.md$/i, '').replace(/ [a-z0-9]{6}$/i, '')
                || 'Untitled';
            return {
                title: title.trim(),
                content: html,
                tags,
                pinned: d.pinned === true,
                ...(d.created && !existing ? { createdAt: String(d.created) } : {})
            };
        }
        const dateRaw = d.date ? String(d.date) : null;
        const date = dateRaw && !isNaN(Date.parse(dateRaw)) ? new Date(dateRaw).toISOString()
            : (existing ? existing.date : (/^(\d{4}-\d{2}-\d{2})/.exec(fileName) ? new Date(RegExp.$1 + 'T12:00:00').toISOString() : fileISO));
        return {
            content: html,
            mood: d.mood ? String(d.mood) : (existing ? existing.mood : 'neutral'),
            tags,
            date,
            ...(d.created && !existing ? { createdAt: String(d.created) } : {})
        };
    },

    _ensureTags(tags) {
        if (typeof NotesApp === 'undefined' || !Array.isArray(tags) || !tags.length) return;
        if (!Array.isArray(NotesApp.tags) || !NotesApp.tags.length) { try { NotesApp.loadTags?.(); } catch { /* fine */ } }
        if (!Array.isArray(NotesApp.tags)) return;
        let added = false;
        for (const name of tags) {
            if (!NotesApp.tags.some(t => String(t.name).toLowerCase() === name.toLowerCase())) {
                NotesApp.tags.push({ id: UIUtils.generateId(), name, profile: 'default' });
                added = true;
            }
        }
        if (added && typeof NotesApp.saveTags === 'function') NotesApp.saveTags();
    },

    async reveal(kind) {
        if (!window.electronContentFiles) return;
        await window.electronContentFiles.reveal(kind || null);
    },

    // ── pure helpers (Node-exported, tested) ──────────────────────────────

    _appOwned(kind, rec) {
        if (kind !== 'notes') return undefined;
        const o = {};
        for (const k of ['template', 'bookNumbered', 'bookLayout', 'prompt', 'sourceNoteId', 'sourceNoteModifiedAt']) {
            if (rec[k] !== undefined && rec[k] !== null) o[k] = rec[k];
        }
        return Object.keys(o).length ? o : undefined;
    },

    /**
     * Filename for a record: notes by title, journal by date. Stable while
     * the title/date holds; a collision gets the id's tail appended. A name
     * that still fits is kept (no churn), and a name WE did not derive —
     * the user's own, from Obsidian or Finder — is kept whatever the title
     * does: `prevTitle` is the title the current name was derived from, so
     * a rename happens only when the file carries our old derivation.
     */
    fileNameFor(kind, rec, taken, current, prevTitle) {
        const tail = ContentFiles.safeSegment(String(rec.id || '')).slice(-6) || 'x';
        const baseOf = (r, title) => {
            if (kind === 'notes') return ContentFiles.slug(title) || 'Untitled';
            const d = new Date(r.date || r.createdAt || 0);
            return isNaN(d) ? 'entry' : ContentFiles.localDate(d);
        };
        const base = baseOf(rec, rec.title || '');
        const plain = `${base}.md`;
        const suffixed = `${base} ${tail}.md`;
        if (current === plain || current === suffixed) return current;
        if (current && kind === 'notes') {
            const prevBase = baseOf(rec, prevTitle == null ? '' : prevTitle);
            const ours = prevTitle != null && (current === `${prevBase}.md` || current === `${prevBase} ${tail}.md`);
            if (!ours) return current;
        }
        if (!taken || !taken.has(plain)) return plain;
        return suffixed;
    },

    slug(title) {
        return String(title || '')
            .replace(/[\\/:*?"<>|#^[\]\0]/g, ' ')  // Finder/Obsidian-unsafe
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80)
            .replace(/[. ]+$/, '');
    },
    safeSegment(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, ''); },
    localDate(d) {
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    },
    extFor(mime) {
        const m = String(mime || '').toLowerCase();
        return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
            'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' }[m] || (m.startsWith('video/') ? 'mp4' : 'png');
    },
    escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); },

    /** djb2 over the text — cheap, and only compared against our own writes. */
    hash(text) {
        let h = 5381;
        const s = String(text || '');
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(16) + ':' + s.length;
    },

    /**
     * Minimal YAML frontmatter, the dialect Obsidian writes and reads:
     * scalars, `[a, b]` flow lists, `- a` block lists, quoted strings, and
     * one JSON flow mapping (`anjadhe: {...}`) for app-owned fields.
     */
    frontmatterStringify(obj) {
        const lines = ['---'];
        const q = (v) => {
            const s = String(v);
            return /^[A-Za-z0-9 _./:+-]*$/.test(s) && !/^(true|false|null|~|-)$/i.test(s) && !/^[\d.]+$/.test(s) && s.trim() === s && s !== ''
                ? s : JSON.stringify(s);
        };
        for (const [k, v] of Object.entries(obj)) {
            if (v === undefined) continue;
            if (Array.isArray(v)) lines.push(`${k}: [${v.map(q).join(', ')}]`);
            else if (typeof v === 'boolean') lines.push(`${k}: ${v}`);
            else if (v && typeof v === 'object') lines.push(`${k}: ${JSON.stringify(v)}`);
            else lines.push(`${k}: ${q(v ?? '')}`);
        }
        lines.push('---');
        return lines.join('\n') + '\n';
    },

    frontmatterParse(text) {
        const s = String(text || '').replace(/^﻿/, '');
        const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?(?:\r?\n)?/.exec(s);
        if (!m) return { data: {}, body: s };
        const data = {};
        const lines = m[1].split(/\r?\n/);
        const unq = (v) => {
            const t = v.trim();
            if (/^".*"$/.test(t)) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
            if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
            if (t === 'true') return true;
            if (t === 'false') return false;
            if (t === 'null' || t === '~') return null;
            return t;
        };
        let listKey = null;
        for (const line of lines) {
            const li = /^\s*-\s+(.*)$/.exec(line);
            if (li && listKey) { data[listKey].push(unq(li[1])); continue; }
            const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
            if (!kv) continue;
            listKey = null;
            const key = kv[1], raw = kv[2].trim();
            if (raw === '') { data[key] = []; listKey = key; continue; }
            if (/^\[.*\]$/.test(raw)) {
                data[key] = raw.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean).map(unq);
                continue;
            }
            if (/^\{.*\}$/.test(raw)) { try { data[key] = JSON.parse(raw); } catch { data[key] = raw; } continue; }
            data[key] = unq(raw);
        }
        return { data, body: s.slice(m[0].length) };
    },

    htmlToText(html) {
        return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li)>/gi, '\n').replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
    },
    textToHtml(text) {
        const esc = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return esc.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = ContentFiles;
