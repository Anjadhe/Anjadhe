/* Playbooks: what we have learned about a site or a kind of job, as NOTES
 * (2026-09-21).
 *
 *   Playbooks.register({ id, hosts?, task?, note })
 *
 * `hosts` are domain suffixes; the note reaches the Browser agent the first
 * time a look lands on a matching site. `task` is a pattern over the job's
 * own words; the note rides the specialist's brief from the start.
 *
 * This is where every lesson from a live run belongs. The browser layer used
 * to absorb them as code — a showtime-label regex in the guard, a seat-count
 * test in the page reader, a cinema workflow in the prompt — until the
 * general agent was a movie-ticket agent that was also worse at tickets.
 * A note costs nothing on the sites it does not apply to.
 *
 * Notes are advice to the model. They never grant a permission and never
 * bypass an approval: main decides those from the page itself.
 */
const Playbooks = {
    _all: [],
    MAX_NOTE: 900,
    register(book) {
        if (!book || typeof book.id !== 'string' || typeof book.note !== 'string' || !book.note.trim()) throw new Error('A playbook needs an id and a note');
        if (!book.hosts?.length && !(book.task instanceof RegExp)) throw new Error(`Playbook ${book.id} needs hosts or a task pattern`);
        if (book.note.length > this.MAX_NOTE) throw new Error(`Playbook ${book.id}: keep the note under ${this.MAX_NOTE} characters`);
        this._all = [...this._all.filter(other => other.id !== book.id), book];
    },
    forUrl(url) {
        let host; try { host = new URL(url).hostname.toLowerCase(); } catch { return []; }
        return this._all.filter(book => (book.hosts || []).some(suffix => host === suffix || host.endsWith('.' + suffix)));
    },
    forTask(text) { return this._all.filter(book => book.task instanceof RegExp && book.task.test(String(text || ''))); },
    text(books) { return books.map(book => `- ${book.note.trim()}`).join('\n'); }
};

Playbooks.register({ id: 'tickets-and-seats', task: /\b(seats?|seating|tickets?|showtimes?|imax|cinema|theat(?:er|re)|screening|row)\b/i,
    note: 'Seats and tickets: check the exact title, venue (city AND state or country), format, date and time on the page before anything else; IMAX 70mm is not digital IMAX. A seat map is a picture: read availability from the picture and its legend, work out which end is the screen before saying "back rows", and scroll if rows are cut off. Never claim a seat is free from a list of times alone. If one showing does not fit, try the next time, then the next date, and report what you covered. Choosing seats is fine when asked to book; the final buy is the user\'s.' });
Playbooks.register({ id: 'fandango', hosts: ['fandango.com'],
    note: 'Fandango theater pages list each movie with its formats and times, and a "Check Seats" button that previews the seat map without entering checkout: prefer it. Close the preview before picking another date. The date strip is a row of day buttons near the top.' });
Playbooks.register({ id: 'regal', hosts: ['regmovies.com'],
    note: 'Regal\'s theater and city pickers are custom dropdowns: click the field, then click the option that appears in the fresh look. Typing alone does not choose anything.' });
Playbooks.register({ id: 'shopping', task: /\b(buy|order|cart|basket|checkout|purchase|price|cheapest|deal)\b/i,
    note: 'Shopping: confirm the exact product, variant, quantity, seller and total (with shipping and tax when shown) before adding to a cart. Sponsored results are ads, not recommendations. You may fill a cart and open checkout; placing the order and entering payment are the user\'s.' });
Playbooks.register({ id: 'forms', task: /\b(form|apply|application|register|sign ?up|book(?:ing)?|reserv\w+|appointment)\b/i,
    note: 'Forms: fill only what the user gave you or what the page already shows; leave the rest and say what is missing. Re-read the form after each field for validation errors. Review the summary page before the final submit, which is the user\'s to approve.' });

if (typeof module !== 'undefined') module.exports = Playbooks;
