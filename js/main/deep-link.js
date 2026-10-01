'use strict';
/**
 * anjadhe:// deep links — the one parser for every door that hands the app
 * a URL from outside: the Chrome extension's toolbar button and context
 * menu today, a Shortcuts action or a share sheet tomorrow.
 *
 * Grammar (query strings are percent-encoded):
 *
 *   anjadhe://read?url=<http(s) URL>[&title=<page title>]
 *
 * Only http(s) targets pass — a file:, javascript: or chrome: address from
 * a hostile page must never reach read-url. The title is advisory: the
 * News reader prefers it over a paywalled page's empty extract, so the
 * coverage search has a headline to run on. Pure, Node-required, pinned by
 * tests/deep-link-test.js.
 */

const SCHEME = 'anjadhe';
const TITLE_MAX = 300;

/**
 * @param {string} raw
 * @returns {{action:'read', url:string, title:string}|null}
 */
function parseDeepLink(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== `${SCHEME}:`) return null;
    // `anjadhe://read?…` parses with host "read"; `anjadhe:read?…` and
    // `anjadhe:///read` land it in the pathname instead. Accept all three.
    const action = (u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase();
    if (action !== 'read') return null;
    const target = String(u.searchParams.get('url') || '').trim();
    let t;
    try { t = new URL(target); } catch { return null; }
    if (t.protocol !== 'http:' && t.protocol !== 'https:') return null;
    if (!t.hostname.includes('.') && t.hostname !== 'localhost') return null;
    const title = String(u.searchParams.get('title') || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
    return { action: 'read', url: t.href, title };
}

/** The link the extension builds — kept here so both ends agree. */
function buildReadLink(url, title) {
    const q = new URLSearchParams();
    q.set('url', String(url || ''));
    if (title) q.set('title', String(title).slice(0, TITLE_MAX));
    return `${SCHEME}://read?${q.toString()}`;
}

/** argv scan for platforms that hand the link to a new process. */
function deepLinkFromArgv(argv) {
    for (const a of (argv || [])) {
        if (typeof a === 'string' && a.toLowerCase().startsWith(`${SCHEME}:`)) return a;
    }
    return null;
}

module.exports = { SCHEME, TITLE_MAX, parseDeepLink, buildReadLink, deepLinkFromArgv };
