/**
 * notify-format.js — the one builder of a forwarded notification's text.
 * ====================================================================
 * A desktop notification that leaves this Mac for a messaging app
 * (Telegram, iMessage) wears a header naming what it is — "Anjadhe ·
 * Reminder" — above its title and body. In a Telegram chat the same
 * thread carries the assistant's replies as plain prose, and a bare
 * "Standup / 9:00 AM" read like the assistant answering something nobody
 * asked; in iMessage the header says why your own number is texting you.
 * Both bridges build from here so the two channels can never drift.
 *
 * `kind` is named by the call site through `Notify.show(…, { kind })`:
 * reminder | task | routine | email. Anything else reads "Notification".
 */
const NOTIFY_KINDS = { reminder: 'Reminder', task: 'Task', routine: 'Routine', email: 'Email' };

/**
 * @returns {{header: string, title: string, body: string, text: string} | null}
 *   null when there is nothing to say (empty title AND body).
 */
function notificationText(title, body, kind) {
    const t = String(title || '').trim();
    const b = String(body || '').trim();
    if (!t && !b) return null;
    const header = `Anjadhe · ${NOTIFY_KINDS[String(kind || '').toLowerCase()] || 'Notification'}`;
    return { header, title: t, body: b, text: [header, t, b].filter(Boolean).join('\n') };
}

module.exports = { NOTIFY_KINDS, notificationText };
