#!/usr/bin/env node
/**
 * EventDetails (js/apps/calendar/event-details.js) — what an event says
 * beyond title and time, read one way for Google and Apple — and the Apple
 * builder's half of the shared shape (AppleImport._appleEventExtras).
 *
 *   node tests/calendar-event-details-test.js
 */

const EventDetails = require('../js/apps/calendar/event-details.js');
const AppleImport = require('../js/core/apple-import.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── The call ────────────────────────────────────────────────────────────

const googleMeet = {
    meeting: { url: 'https://meet.google.com/abc-defg-hij', label: 'Google Meet',
        dialIn: [{ label: '+1 555-0100', uri: 'tel:+1-555-0100', pin: '123456' }] },
};
let m = EventDetails.meetingOf(googleMeet);
check('Google conference data is the call', m.url === 'https://meet.google.com/abc-defg-hij' && m.label === 'Google Meet');
check('dial-ins survive', m.dialIn.length === 1 && m.dialIn[0].pin === '123456');

m = EventDetails.meetingOf({ description: 'Join: https://us02web.zoom.us/j/8812345678?pwd=xyz.' });
check('a Zoom link in the notes is the call', m && m.label === 'Zoom' && m.url === 'https://us02web.zoom.us/j/8812345678?pwd=xyz');

m = EventDetails.meetingOf({ location: 'Room 4', url: 'https://teams.microsoft.com/l/meetup-join/19%3a' });
check('Apple URL field with a Teams link is the call', m && m.label === 'Microsoft Teams');

m = EventDetails.meetingOf({ location: 'https://example.com/agenda', description: 'see https://docs.google.com/x' });
check('an ordinary link is not a call', m === null);

m = EventDetails.meetingOf({ description: 'https://app.slack.com/huddle/T1/C2' });
check('a Slack huddle is a call', m && m.label === 'Slack huddle');
check('a Slack channel link is not', EventDetails.meetingOf({ description: 'https://acme.slack.com/archives/C1' }) === null);
check('lookalike host is not a call', EventDetails.meetingOf({ description: 'https://zoom.us.evil.example/j/1' }) === null);

// ── People ──────────────────────────────────────────────────────────────

const ev = {
    organizer: { email: 'dana@x.com', displayName: 'Dana', self: false },
    attendees: [
        { email: 'room@x.com', displayName: 'Room 4', responseStatus: 'accepted', resource: true },
        { email: 'me@x.com', responseStatus: 'tentative', self: true },
        { email: 'lee@x.com', displayName: 'Lee', responseStatus: 'declined', comment: 'Out sick' },
        { email: 'dana@x.com', displayName: 'Dana', responseStatus: 'accepted', organizer: true },
        { email: 'kim@x.com', responseStatus: 'needsAction', optional: true },
    ],
};
const people = EventDetails.people(ev);
check('organizer first, room last', people[0].name === 'Dana' && people[people.length - 1].name === 'Room 4',
    people.map(p => p.name).join(','));
check('status words', people.find(p => p.email === 'me@x.com').statusWord === 'Maybe'
    && people.find(p => p.email === 'lee@x.com').statusWord === 'Declined');
check('notes name you / optional', people.find(p => p.email === 'me@x.com').note === 'you'
    && people.find(p => p.email === 'kim@x.com').note === 'optional');
check('response tally skips rooms', EventDetails.responseSummary(ev) === '1 going, 1 maybe, 1 no reply, 1 declined',
    EventDetails.responseSummary(ev));
check('organizer named', EventDetails.organizerName(ev) === 'Dana');
check('own organizer not named', EventDetails.organizerName({ organizer: { email: 'me@x.com', self: true } }) === '');

// ── Words ───────────────────────────────────────────────────────────────

check('busy says nothing', EventDetails.showAsWord({ showAs: '' }) === '');
check('free', EventDetails.showAsWord({ showAs: 'free' }) === 'Free');
check('out of office type', EventDetails.showAsWord({ eventType: 'outOfOffice' }) === 'Out of office');
check('reminders in words',
    EventDetails.remindersWord({ reminders: { overrides: [{ method: 'popup', minutes: 10 }, { method: 'email', minutes: 1440 }] } })
        === '10 min before, 1 day before (email)');
check('calendar default', EventDetails.remindersWord({ reminders: { useDefault: true, overrides: [] } }) === 'Calendar default');
check('at start', EventDetails.remindersWord({ reminders: { overrides: [{ minutes: 0 }] } }) === 'At start');
check('map link from coordinates', EventDetails.mapUrl({ geo: { lat: 37.33, lng: -122.03, title: 'Apple Park' } })
    === 'https://maps.apple.com/?ll=37.33,-122.03&q=Apple%20Park');
check('foreign zone only', EventDetails.foreignTimeZone({ timeZone: 'Asia/Kolkata' }, 'America/Los_Angeles') === 'Asia/Kolkata'
    && EventDetails.foreignTimeZone({ timeZone: 'America/Los_Angeles' }, 'America/Los_Angeles') === '');

// ── Facts for the assistant ─────────────────────────────────────────────

const f = EventDetails.facts({ ...ev, ...googleMeet, htmlLink: 'https://calendar.google.com/e', timeZone: 'America/Los_Angeles' },
    '', { localZone: 'America/Los_Angeles' });
check('facts carry the call and dial-in', f.videoCall.includes('meet.google.com') && f.dialIn.includes('PIN 123456'));
check('facts carry your response', f.yourResponse === 'Maybe');
check('facts skip the local zone and the link by default', !('timeZone' in f) && !('openInGoogleCalendar' in f));
check('facts on a bare event are empty', Object.keys(EventDetails.facts({ summary: 'x' })).length === 0);

// ── Apple rows land in the same shape ───────────────────────────────────

const [apple] = AppleImport.buildCalendarEvents([{
    externalId: 'E1', eventId: 'e1', title: 'Design review', notes: '', location: 'Apple Park',
    start: '2026-09-23T17:00:00Z', end: '2026-09-23T18:00:00Z', allDay: false,
    calendarId: 'C1', calendarTitle: 'Work', hasRecurrence: false, rrule: '', isDetached: false,
    url: 'https://facetime.apple.com/join#v=1&p=abc', timeZone: 'America/Los_Angeles',
    availability: 'free', status: 'tentative',
    organizer: { name: 'Dana', email: 'dana@x.com', status: 'accepted', role: 'chair', type: 'person', self: false },
    attendees: [
        { name: 'Dana', email: 'dana@x.com', status: 'accepted', role: 'chair', type: 'person', self: false },
        { name: '', email: 'me@x.com', status: 'needsAction', role: 'optional', type: 'person', self: true },
        { name: 'Room 4', email: '', status: 'accepted', role: 'required', type: 'room', self: false },
    ],
    alarms: [{ minutes: 15 }, { at: '2026-09-23T08:00:00Z' }],
    geo: { title: 'Apple Park', lat: 37.3349, lng: -122.009 },
    created: '2026-09-01T10:00:00Z', updated: '2026-09-20T10:00:00Z',
}], [{ id: 'C1', writable: true }]);
check('Apple organizer mapped', apple.organizer.displayName === 'Dana' && apple.organizer.email === 'dana@x.com');
check('Apple organizer flagged among attendees', apple.attendees[0].organizer === true);
check('Apple statuses in Google vocabulary', apple.attendees[1].responseStatus === 'needsAction' && apple.attendees[1].optional);
check('Apple room is a resource', apple.attendees[2].resource === true);
check('Apple show-as, status, zone', apple.showAs === 'free' && apple.status === 'tentative' && apple.timeZone === 'America/Los_Angeles');
check('Apple alarms become reminders', EventDetails.remindersWord(apple, () => 'AT').startsWith('15 min before, AT'));
check('Apple FaceTime URL is the call', EventDetails.meetingOf(apple)?.label === 'FaceTime');
check('Apple geo gives a map', EventDetails.mapUrl(apple).startsWith('https://maps.apple.com/?ll=37.3349,-122.009'));
check('Apple non-http URL dropped', AppleImport.buildCalendarEvents([{
    externalId: 'E2', start: '2026-09-23T17:00:00Z', url: 'javascript:alert(1)' }])[0].url === '');
check('Apple busy says nothing', AppleImport.buildCalendarEvents([{
    externalId: 'E3', start: '2026-09-23T17:00:00Z', availability: 'busy' }])[0].showAs === '');

if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nAll calendar event-details checks passed.');
