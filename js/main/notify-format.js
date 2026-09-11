/**
 * notify-format.js — the one builder of a forwarded notification's text.
 * ====================================================================
 * A desktop notification that leaves this Mac for a messaging app
 * (Telegram, iMessage) wears a header naming what it is — "Reminder",
 * "Email" — above its title and body. In a Telegram chat the same thread
 * carries the assistant's replies as plain prose, and a bare
 * "Standup / 9:00 AM" read like the assistant answering something nobody
 * asked; in iMessage the header says why your own number is texting you.
 * Both bridges build from here so the two channels can never drift.
 *
 * The header is the KIND alone. It used to read "Anjadhe · Reminder", and
 * the app name on every single message was noise (2026-09-03, by
 * request): the chat is the app's own bot, the iMessage thread is the
 * user's own number, so the sender is already known. What the reader
 * needs is what this is and what it is about — the body is where the
 * call sites now put a real summary (when, what, from whom) rather than a
 * bare time. The forwarded body is capped at BODY_MAX so a long insight
 * list or task goal stays a notification, not a page.
 *
 * `kind` is named by the call site through `Notify.show(…, { kind })`:
 * reminder | task | routine | email | message (an insight from a text).
 * Anything else reads "Notification".
 */
const NOTIFY_KINDS = { reminder: 'Reminder', task: 'Task', routine: 'Routine', email: 'Email', message: 'Message' };
const BODY_MAX = 700;

/**
 * @returns {{header: string, title: string, body: string, text: string} | null}
 *   null when there is nothing to say (empty title AND body).
 */
function notificationText(title, body, kind) {
    const t = String(title || '').trim();
    let b = String(body || '').trim();
    if (!t && !b) return null;
    if (b.length > BODY_MAX) b = b.slice(0, BODY_MAX - 1).trimEnd() + '…';
    const header = NOTIFY_KINDS[String(kind || '').toLowerCase()] || 'Notification';
    return { header, title: t, body: b, text: [header, t, b].filter(Boolean).join('\n') };
}

module.exports = { NOTIFY_KINDS, BODY_MAX, notificationText };
