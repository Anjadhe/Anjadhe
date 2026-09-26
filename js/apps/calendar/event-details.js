/**
 * EventDetails — everything an event says beyond title and time, read the
 * same way for both sources (2026-09-22).
 *
 * Google (main.js mapCalendarEvent) and Apple (AppleImport.buildCalendarEvents
 * over the EventKit helper) both store one shape: organizer, attendees with a
 * status, meeting, url, showAs, visibility, eventType, reminders,
 * attachments, geo, timeZone, created, updated. This module turns that shape
 * into what people read — the detail rows, the home card's Join button, the
 * assistant's context and the calendar tool — so the four cannot disagree
 * about what an event holds.
 *
 * Pure (no DOM, no app objects); Node-exported and pinned by
 * tests/calendar-event-details-test.js.
 */
const EventDetails = {
    // Video-call hosts, matched on the URL's host. A link to one of these in
    // the event's own url field, its location or its notes IS the call —
    // Zoom and Teams invites from Outlook put it in the description, and
    // Apple events carry it in the URL field or the location.
    MEETING_HOSTS: [
        [/(^|\.)meet\.google\.com$/, 'Google Meet'],
        [/(^|\.)zoom\.us$/, 'Zoom'],
        [/(^|\.)zoomgov\.com$/, 'Zoom'],
        [/(^|\.)teams\.microsoft\.com$/, 'Microsoft Teams'],
        [/(^|\.)teams\.live\.com$/, 'Microsoft Teams'],
        [/(^|\.)webex\.com$/, 'Webex'],
        [/(^|\.)facetime\.apple\.com$/, 'FaceTime'],
        [/(^|\.)whereby\.com$/, 'Whereby'],
        [/(^|\.)chime\.aws$/, 'Amazon Chime'],
        [/(^|\.)bluejeans\.com$/, 'BlueJeans'],
        [/(^|\.)(gotomeeting\.com|meet\.goto\.com)$/, 'GoTo Meeting'],
        [/(^|\.)slack\.com$/, null], // only huddle links, checked below
    ],

    URL_RX: /https?:\/\/[^\s<>"')\]]+/gi,

    _host(url) {
        try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
    },

    // The provider's name when `url` is a call link, else null.
    meetingLabel(url) {
        const host = this._host(url);
        if (!host) return null;
        for (const [rx, label] of this.MEETING_HOSTS) {
            if (!rx.test(host)) continue;
            if (label) return label;
            if (/\/huddle/i.test(url)) return 'Slack huddle';
        }
        return null;
    },

    _stripTrailing(url) {
        return url.replace(/[.,;:!?]+$/, '');
    },

    // Every http(s) address in a piece of text, in order.
    urlsIn(text) {
        if (!text) return [];
        return (String(text).match(this.URL_RX) || []).map(u => this._stripTrailing(u));
    },

    /**
     * The event's call: { url, label, dialIn: [{label, uri, pin}] } or null.
     * Google's conference data wins (it is the calendar's own statement);
     * otherwise the first call link found in url → location → notes.
     * `descriptionText` is the notes as plain text (HTML already stripped
     * by the caller, which owns that conversion).
     */
    meetingOf(ev, descriptionText = '') {
        if (!ev) return null;
        if (ev.meeting?.url) return { dialIn: [], ...ev.meeting, label: ev.meeting.label || this.meetingLabel(ev.meeting.url) || '' };
        const candidates = [
            ...(ev.url ? [ev.url] : []),
            ...this.urlsIn(ev.location),
            ...this.urlsIn(descriptionText || ev.description),
        ];
        for (const url of candidates) {
            const label = this.meetingLabel(url);
            if (label) return { url, label, dialIn: [] };
        }
        return null;
    },

    STATUS_WORDS: {
        accepted: 'Going',
        declined: 'Declined',
        tentative: 'Maybe',
        needsAction: 'No reply',
        delegated: 'Delegated',
    },

    personName(p) {
        if (!p) return '';
        return p.displayName || p.name || p.email || '';
    },

    /**
     * Attendees in reading order: the organizer first, then going, maybe,
     * no reply, declined; rooms and resources last. Each row carries the
     * words the UI prints: { name, email, status, statusWord, note }.
     */
    people(ev) {
        const rank = { accepted: 0, tentative: 1, needsAction: 2, '': 2, delegated: 3, declined: 4 };
        const rows = (ev?.attendees || []).map(a => {
            const notes = [];
            if (a.organizer) notes.push('organizer');
            if (a.self) notes.push('you');
            if (a.optional || a.role === 'optional') notes.push('optional');
            if (a.resource || a.type === 'room' || a.type === 'resource') notes.push(a.type === 'resource' ? 'resource' : 'room');
            return {
                name: this.personName(a) || 'Unknown',
                email: a.email || '',
                status: a.responseStatus || a.status || '',
                statusWord: this.STATUS_WORDS[a.responseStatus || a.status] || '',
                note: notes.join(', '),
                comment: a.comment || '',
                _organizer: !!a.organizer,
                _resource: notes.includes('room') || notes.includes('resource'),
            };
        });
        rows.sort((x, y) =>
            (y._organizer - x._organizer)
            || (x._resource - y._resource)
            || ((rank[x.status] ?? 2) - (rank[y.status] ?? 2)));
        return rows;
    },

    // "3 going, 1 maybe, 2 no reply" — only the counts that are non-zero.
    responseSummary(ev) {
        const people = this.people(ev).filter(p => !p._resource);
        if (people.length < 2) return '';
        const counts = {};
        for (const p of people) {
            const w = p.statusWord || 'No reply';
            counts[w] = (counts[w] || 0) + 1;
        }
        const order = ['Going', 'Maybe', 'No reply', 'Declined', 'Delegated'];
        return order.filter(w => counts[w]).map(w => `${counts[w]} ${w.toLowerCase()}`).join(', ');
    },

    // The organizer as a name, or '' when it is the user (nothing to say).
    organizerName(ev) {
        const o = ev?.organizer;
        if (!o || o.self) return '';
        return this.personName(o);
    },

    SHOW_AS: { free: 'Free', tentative: 'Tentative', unavailable: 'Out of office' },

    // Only when it differs from the default (busy) — a row saying "Busy" on
    // every meeting would be noise.
    showAsWord(ev) {
        if (ev?.eventType === 'outOfOffice') return 'Out of office';
        return this.SHOW_AS[ev?.showAs] || '';
    },

    EVENT_TYPES: {
        focusTime: 'Focus time',
        outOfOffice: 'Out of office',
        workingLocation: 'Working location',
        birthday: 'Birthday',
        fromGmail: 'From Gmail',
    },

    eventTypeWord(ev) {
        return this.EVENT_TYPES[ev?.eventType] || '';
    },

    visibilityWord(ev) {
        return ({ private: 'Private', confidential: 'Private', public: 'Public' })[ev?.visibility] || '';
    },

    _minutesWord(m) {
        if (m === 0) return 'At start';
        const after = m < 0;
        const n = Math.abs(m);
        let t;
        if (n % 10080 === 0) t = `${n / 10080} week${n === 10080 ? '' : 's'}`;
        else if (n % 1440 === 0) t = `${n / 1440} day${n === 1440 ? '' : 's'}`;
        else if (n % 60 === 0) t = `${n / 60} hour${n === 60 ? '' : 's'}`;
        else t = `${n} min`;
        return `${t} ${after ? 'after' : 'before'}`;
    },

    /**
     * Reminders as words: "10 min before, 1 day before (email)". Google's
     * "use the calendar default" says so rather than inventing a number.
     * `formatAt(iso)` renders an absolute Apple alarm.
     */
    remindersWord(ev, formatAt = (s) => s) {
        const r = ev?.reminders;
        if (!r) return '';
        if (r.useDefault && !(r.overrides || []).length) return 'Calendar default';
        return (r.overrides || []).map(o => {
            const base = o.at ? formatAt(o.at) : this._minutesWord(Number(o.minutes) || 0);
            return o.method && o.method !== 'popup' ? `${base} (${o.method})` : base;
        }).join(', ');
    },

    // A maps link for a location with coordinates (Apple's structured
    // location). Apple Maps, since this is a Mac app.
    mapUrl(ev) {
        const g = ev?.geo;
        if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lng)) return '';
        const q = g.title ? `&q=${encodeURIComponent(g.title)}` : '';
        return `https://maps.apple.com/?ll=${g.lat},${g.lng}${q}`;
    },

    // The event's own time zone, only when it is not the viewer's.
    foreignTimeZone(ev, localZone) {
        const tz = ev?.timeZone;
        return tz && localZone && tz !== localZone ? tz : '';
    },

    /**
     * Plain-text facts for the assistant — the context block and the
     * calendar tool. Only fields the event actually has. `localZone` drops a
     * time zone that is the Mac's own; `withLinks` adds the Google Calendar
     * link (useful on the one event being viewed, noise in a listing).
     */
    facts(ev, descriptionText = '', { localZone = '', withLinks = false } = {}) {
        const out = {};
        const meeting = this.meetingOf(ev, descriptionText);
        if (meeting) {
            out.videoCall = meeting.label ? `${meeting.label}: ${meeting.url}` : meeting.url;
            if (meeting.dialIn?.length) {
                out.dialIn = meeting.dialIn.map(d => [d.label || d.uri, d.pin ? `PIN ${d.pin}` : ''].filter(Boolean).join(' ')).join('; ');
            }
        }
        if (ev.url && (!meeting || meeting.url !== ev.url)) out.url = ev.url;
        const org = this.organizerName(ev);
        if (org) out.organizer = ev.organizer.email && ev.organizer.email !== org ? `${org} <${ev.organizer.email}>` : org;
        const people = this.people(ev);
        if (people.length) {
            out.attendees = people.map(p => {
                const bits = [p.statusWord, p.note].filter(Boolean).join(', ');
                const who = p.email && p.email !== p.name ? `${p.name} <${p.email}>` : p.name;
                return bits ? `${who} (${bits})` : who;
            });
        }
        const myStatus = (ev.attendees || []).find(a => a.self);
        if (myStatus) out.yourResponse = this.STATUS_WORDS[myStatus.responseStatus || myStatus.status] || 'No reply';
        const showAs = this.showAsWord(ev); if (showAs) out.showAs = showAs;
        const type = this.eventTypeWord(ev); if (type) out.eventType = type;
        const vis = this.visibilityWord(ev); if (vis) out.visibility = vis;
        if (ev.status === 'tentative') out.status = 'Tentative';
        const rem = this.remindersWord(ev); if (rem) out.reminders = rem;
        if (ev.attachments?.length) out.attachments = ev.attachments.map(a => a.title ? `${a.title}: ${a.url}` : a.url);
        const tz = localZone ? this.foreignTimeZone(ev, localZone) : ev.timeZone;
        if (tz) out.timeZone = tz;
        if (withLinks && ev.htmlLink) out.openInGoogleCalendar = ev.htmlLink;
        return out;
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = EventDetails;
