/**
 * App Manifest (v1) — validation for app packages.
 *
 * A user app is a folder under ~/Anjadhe/apps/<id>/ containing:
 *   manifest.json  — this document
 *   app.js         — entry script; must call Anjadhe.registerApp({...})
 *   app.css        — optional stylesheet (design-system variables, see CLAUDE.md)
 *
 * A BUNDLED app (first-party, ships in the DMG, runs in-process) is a folder
 * under js/apps/<id>/ listed in js/apps/bundled.json, with the same manifest
 * plus the bundled-only fields `validate(raw, { bundled: true })` admits:
 *   scripts          — files loaded in order (the app registers itself)
 *   styles           — stylesheets injected into <head>
 *   view             — an HTML fragment appended to #app-views (the app's view div)
 *   group            — registry group label ("Health"); tile lands there
 *   hiddenByDefault  — starts OFF in the launcher (AppManager.DEFAULT_HIDDEN_APPS)
 *   feature          — FEATURES flag key that gates the app (data-feature on the tile)
 *   subappOf         — reached through that app, not from a launcher (data-subapp-of)
 *   eager            — call the app's init() right after its scripts load
 *   icon             — may be inline SVG markup (a user app's icon is an entity)
 * See docs/PLATFORM.md "App packages" and js/core/bundled-apps.js.
 *
 * Validation is shape-only and side-effect free; collision checks against
 * the live registry happen at mount time in AppManager. The platform plan
 * and full contract live in docs/PLATFORM.md.
 */

const AppManifest = {
    VERSION: 1,

    // Ids that can never be claimed by a user app: routes and DOM ids that
    // exist outside the app registry (built-in app ids are caught at mount
    // time by the registry collision check instead, so this list doesn't
    // need to chase new built-ins).
    RESERVED_IDS: new Set(['home', 'dashboard', 'setup', 'app', 'views', 'prompts']),

    ID_RE: /^[a-z][a-z0-9-]{1,40}$/,

    /**
     * Portability of an app, derived from its entry (docs/PLATFORM.md). A spec
     * app (app.spec.json) is pure data the shared engine renders, so it runs on
     * Mac AND the iOS companion. A code app (app.js) runs JS, which is Mac-only.
     * iOS sync surfaces only portable apps. `entry` is the manifest's entry (or
     * a whole manifest — both accepted).
     * @returns {'portable'|'mac-only'}
     */
    portabilityOf(entryOrManifest) {
        const entry = (entryOrManifest && typeof entryOrManifest === 'object')
            ? entryOrManifest.entry
            : entryOrManifest;
        return entry === 'app.spec.json' ? 'portable' : 'mac-only';
    },

    portabilityLabel(p) {
        return p === 'portable' ? 'Mac + iPhone' : 'Mac only';
    },

    /**
     * Validate a parsed manifest object.
     * @returns {{ok: boolean, errors: string[], manifest?: object}} —
     *   on success, `manifest` is a normalized copy with defaults filled in.
     */
    validate(raw, { bundled = false } = {}) {
        const errors = [];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return { ok: false, errors: ['manifest.json must be a JSON object'] };
        }
        if (raw.manifestVersion !== this.VERSION) {
            errors.push(`manifestVersion must be ${this.VERSION}`);
        }
        if (typeof raw.id !== 'string' || !this.ID_RE.test(raw.id)) {
            errors.push('id must be kebab-case (lowercase letters, digits, hyphens), start with a letter, 2-41 chars');
        } else if (this.RESERVED_IDS.has(raw.id)) {
            errors.push(`id "${raw.id}" is reserved`);
        }
        if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.trim().length > 40) {
            errors.push('name is required (max 40 chars)');
        }
        if (raw.icon != null && (typeof raw.icon !== 'string' || raw.icon.length > (bundled ? 2000 : 24))) {
            errors.push('icon must be a short string — an HTML entity like &#9670; (no emoji in code)');
        }
        if (raw.version != null && typeof raw.version !== 'string') {
            errors.push('version must be a string');
        }
        if (raw.description != null && typeof raw.description !== 'string') {
            errors.push('description must be a string');
        }
        if (raw.entry != null && raw.entry !== 'app.js' && raw.entry !== 'app.spec.json') {
            errors.push('entry must be "app.js" (code app) or "app.spec.json" (spec app)');
        }
        if (raw.keywords != null && (!Array.isArray(raw.keywords) || raw.keywords.some(k => typeof k !== 'string'))) {
            errors.push('keywords must be an array of strings');
        }
        if (raw.reads != null && (!Array.isArray(raw.reads) || raw.reads.some(r => typeof r !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(r)))) {
            errors.push('reads must be an array of built-in app names (e.g. ["journal", "schedule"])');
        }
        if (raw.uses != null && (!Array.isArray(raw.uses) || raw.uses.some(u => typeof u !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]{0,40}$/.test(u)))) {
            errors.push('uses must be an array of cross-app API names (e.g. ["schedule"])');
        }
        if (raw.layout != null && raw.layout !== 'column' && raw.layout !== 'full') {
            errors.push('layout must be "column" (centered reading width, default) or "full" (whole content area)');
        }
        const strList = (k) => {
            if (raw[k] == null) return;
            if (!Array.isArray(raw[k]) || raw[k].some(x => typeof x !== 'string' || !x || x.includes('..') || x.startsWith('/'))) {
                errors.push(`${k} must be an array of file names inside the package folder`);
            }
        };
        if (bundled) {
            strList('scripts'); strList('styles');
            if (raw.view != null && (typeof raw.view !== 'string' || raw.view.includes('..') || raw.view.startsWith('/'))) {
                errors.push('view must be a file name inside the package folder');
            }
            if (raw.feature != null && (typeof raw.feature !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(raw.feature))) {
                errors.push('feature must be a FEATURES flag key');
            }
            if (raw.subappOf != null && (typeof raw.subappOf !== 'string' || !this.ID_RE.test(raw.subappOf))) {
                errors.push('subappOf must be the id of the app this one is reached through');
            }
            if (raw.group != null && (typeof raw.group !== 'string' || !raw.group.trim())) {
                errors.push('group must be a non-empty string');
            }
            // A package may contribute MORE THAN ONE app (Reader + Writing
            // Voices are two lenses over one corpus): each extra gets its
            // own registry tile + label; its view div rides the package's
            // view fragment and its scripts register it like the primary.
            if (raw.extraApps != null && (!Array.isArray(raw.extraApps) || raw.extraApps.some(a =>
                !a || typeof a !== 'object' || !this.ID_RE.test(String(a.id || '')) ||
                typeof a.name !== 'string' || !a.name.trim() ||
                (a.subappOf != null && !this.ID_RE.test(String(a.subappOf)))))) {
                errors.push('extraApps must be an array of { id, name, icon?, group?, description?, subappOf? }');
            }
        }
        if (errors.length) return { ok: false, errors };

        const bundledFields = bundled ? {
            bundled: true,
            scripts: raw.scripts || [],
            styles: raw.styles || [],
            view: raw.view || null,
            group: (raw.group || '').trim() || null,
            feature: raw.feature || null,
            subappOf: raw.subappOf || null,
            eager: !!raw.eager,
            hiddenByDefault: !!raw.hiddenByDefault,
            extraApps: (raw.extraApps || []).map(a => ({
                id: a.id,
                name: a.name.trim(),
                icon: a.icon || '&#9670;',
                group: (a.group || '').trim() || null,
                description: a.description || '',
                subappOf: a.subappOf || null
            }))
        } : {};
        return {
            ok: true,
            errors: [],
            manifest: {
                ...bundledFields,
                manifestVersion: this.VERSION,
                id: raw.id,
                name: raw.name.trim(),
                icon: raw.icon || '&#9670;',
                version: raw.version || '0.1.0',
                description: raw.description || '',
                entry: raw.entry || 'app.js',
                keywords: raw.keywords || [],
                reads: raw.reads || [],
                // Cross-app APIs the app acts through (Anjadhe.use) — the
                // write-side mirror of `reads`. Documentary today; the
                // sandbox bridge will enforce it.
                uses: raw.uses || [],
                layout: raw.layout || 'column'
            }
        };
    }
};

// Loadable as a browser global and as a Node module (tests). Guarded so the
// browser path is untouched.
if (typeof module !== 'undefined' && module.exports) module.exports = AppManifest;
