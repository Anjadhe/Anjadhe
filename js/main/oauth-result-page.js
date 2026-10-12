/** Shared, entirely local browser return page for Google and MCP sign-in.
 * No scripts, fonts, images, analytics or other network requests. Callers
 * escape any remote values before including them in messageHtml.
 */
const { createHash } = require('crypto');

function oauthHtmlEscape(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const styles = `
    :root {
        color-scheme: light dark;
        --ground: #f5f5f3; --surface: #fff; --ink: #171717;
        --secondary: #4f4f4c; --muted: #6f6f6c; --line: #e4e4e0;
        --serif: 'Charter', 'Iowan Old Style', 'Source Serif Pro', 'Palatino', 'Georgia', serif;
    }
    * { box-sizing: border-box; }
    body {
        margin: 0; min-height: 100vh; min-height: 100svh;
        display: grid; place-items: center; padding: 32px 20px;
        background: var(--ground); color: var(--ink);
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Inter, Roboto, Helvetica, Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
    }
    main { width: 100%; max-width: 480px; }
    .brand { display: flex; align-items: center; gap: 10px; margin: 0 0 24px 2px; }
    .brand-name { font: 400 21px/1 var(--serif); }
    .brand-note { margin-left: auto; font-size: 12px; color: var(--muted); }
    .card { padding: 36px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
    .status { display: inline-flex; align-items: center; gap: 9px; font-size: 13px; font-weight: 600; }
    .mark { width: 26px; height: 26px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 50%; }
    .mark.ok { background: var(--ink); border-color: var(--ink); color: var(--surface); }
    svg { display: block; width: 15px; height: 15px; }
    h1 { margin: 24px 0 14px; font: 400 34px/1.15 var(--serif); letter-spacing: -.01em; overflow-wrap: anywhere; }
    .message { margin: 0; font-size: 14.5px; line-height: 1.65; color: var(--secondary); overflow-wrap: anywhere; }
    strong { color: var(--ink); font-weight: 600; }
    .next { display: flex; gap: 10px; align-items: center; margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line); font-size: 13px; color: var(--ink); }
    .next svg { flex: none; }
    footer { padding: 18px 12px 0; text-align: center; color: var(--muted); font-size: 12px; line-height: 1.6; }
    @media (max-width: 400px) { .card { padding: 26px 24px; } h1 { font-size: 28px; } }
    @media (prefers-color-scheme: dark) {
        :root { --ground: #131312; --surface: #1b1b1a; --ink: #ececea; --secondary: #b4b4b0; --muted: #9a9a96; --line: #2a2a28; }
    }
`;

const OAUTH_RESULT_CSP = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(styles).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function oauthResultPage(heading, messageHtml, ok = false) {
    const mark = ok ? '<path d="m5 12 4 4L19 6"/>' : '<path d="m7 7 10 10M17 7 7 17"/>';
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${oauthHtmlEscape(OAUTH_RESULT_CSP)}">
<title>${oauthHtmlEscape(heading)} · nenva</title>
<style>${styles}</style>
</head><body>
<main>
    <div class="brand"><span class="brand-name">nenva</span><span class="brand-note">Account connection</span></div>
    <section class="card" aria-labelledby="result-title">
        <div class="status"><span class="mark${ok ? ' ok' : ''}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${mark}</svg></span> ${ok ? 'Ready to return' : 'Connection not completed'}</div>
        <h1 id="result-title">${oauthHtmlEscape(heading)}</h1>
        <p class="message">${messageHtml}</p>
        <div class="next"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m10 7-5 5 5 5M5 12h14"/></svg>You can close this tab and return to nenva.</div>
    </section>
    <footer>This page is served by nenva on this Mac.</footer>
</main>
</body></html>`;
}

module.exports = { oauthResultPage, oauthHtmlEscape, OAUTH_RESULT_CSP };
