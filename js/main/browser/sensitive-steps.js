'use strict';
/**
 * The browser steps that ask EVERY time, whatever the user has allowed.
 *
 * Law W24 (Ram, 2026-09-20). A Workroom browser may work a task all the way
 * through a checkout: search, choose, add to a cart, fill ordinary fields,
 * open the payment page. Two things it may never do on its own. It cannot
 * FILL a sign-in or payment field — those are refused in page-operations.js
 * (MANUAL_FIELDS), so the user takes control and types them. And it cannot
 * take the irreversible step — buy, pay, confirm an order, send, delete,
 * sign in — without the user saying yes to that exact step, even on a
 * website they chose to always allow.
 *
 * This is the browser twin of `MacTools.RISKY` / `SENSITIVE_TEXT` in
 * js/agent/mac-tools.js (law M4, Ram, 2026-09-13), which already governs the
 * assistant clicking Buy in the user's own Chrome. The two vocabularies are
 * deliberate duplicates in two runtimes, like js/main/news-sources.js and
 * Connect's lib/news.js: change one, change the other.
 *
 * Two properties make this a gate rather than a suggestion:
 *   - It reads the label the PAGE rendered, taken from the last observation
 *     MAIN returned, never a string the model supplied. The model cannot
 *     describe its own click as harmless, the way it cannot choose the
 *     origin under law W10.
 *   - An unreadable target is sensitive. A ref main cannot resolve is a
 *     step nobody can check, so it asks.
 */

// A label that reads as spending money, sending, destroying or authenticating.
const RISKY = /\b(buy|buying|purchase|pay|paying|payment|place (your |my |the )?order|order now|confirm|complete (your |my |the )?(order|purchase|payment|booking|reservation)|checkout|check ?out|proceed to (checkout|payment)|continue to payment|agree and (pay|continue)|send|post|publish|submit|transfer|wire|delete|erase|empty trash|unsubscribe|approve|sign ?in|log ?in|sign ?up|register|subscribe|donate|book( now| tickets?)?|reserve|bid|withdraw|sell|trade|cancel (my |your |the )?(order|subscription|account|plan|membership|booking|reservation)|close (my )?account|install|uninstall|authori[sz]e)\b/i;

// A card, account or national ID number, whatever field it is headed for.
const SENSITIVE_TEXT = /(^|\D)\d(?:[ -]?\d){12,18}(?!\d)|\b\d{3}-\d{2}-\d{4}\b/;

const ACTED = new Set(['click', 'type', 'select_option']);

const quote = text => `“${String(text).slice(0, 80)}”`;

/**
 * Why this step must ask, or null when it may run under a saved permission.
 *
 * @param {string} name     the tool name, with or without the internal prefix
 * @param {object} args     the tool arguments, exactly as they will execute
 * @param {object|null} element  the row MAIN observed for `args.ref`, or null
 *                               when no observation holds that reference
 */
function sensitiveStep(name, args = {}, element = null) {
    const action = String(name || '').replace(/^internal_browser_/, '');
    if (!ACTED.has(action)) return null;

    if (action === 'type' && SENSITIVE_TEXT.test(String(args.text || ''))) {
        return 'That text looks like a card, account or ID number. Only the user enters those, through Take control.';
    }
    // A ref nobody can resolve cannot be checked against the vocabulary.
    if (!element) {
        return 'What this reference points at could not be read from the last page observation, so it cannot be checked.';
    }
    const label = [element.label, element.value, element.placeholder, element.name]
        .filter(part => typeof part === 'string' && part.trim()).join(' ');
    if (RISKY.test(label)) {
        return `${quote(element.label || label)} reads as buying, paying, confirming, sending, deleting or signing in.`;
    }
    return null;
}

module.exports = { sensitiveStep, RISKY, SENSITIVE_TEXT };
