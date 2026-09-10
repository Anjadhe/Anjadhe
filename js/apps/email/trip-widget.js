/**
 * Trips on home — the manifest of an upcoming or in-progress trip.
 *
 * EmailTrips clusters the reservation insights (see email-trips.js for the
 * rules); this card renders each live cluster: one row per reservation leg,
 * in trip order, each opening its insight in Email AI. It appears the
 * moment a trip exists on the horizon — a booking five months out is still
 * a trip you hold — and disappears when the trip's last day passes, which
 * is the widget contract doing the lifecycle for free.
 *
 * The Email card excludes reservations shown here (EmailTrips.coveredIds),
 * the same say-it-once bargain it strikes with tasked insights. The
 * constraint that governs both cards holds: every row here opens in
 * Email AI via FyiPage.openTo.
 *
 * Load note: mirrors the Email card's bootstrap situation, but does NOT
 * repeat its kickLoad — that card owns the app's whole email bootstrap
 * (sync + analysis pipeline). This one only needs the table read;
 * loadData dedupes in-flight callers, so the two never double-load.
 */
(function () {
    const MAX_ROWS = 5;

    let loading = false;

    /** "today" / "tomorrow" / "Aug 20" — absolute beyond the near edge,
     *  because a manifest reads by date, not by countdown. */
    function dayLabel(iso, todayISO) {
        const today = new Date(todayISO + 'T00:00:00');
        const then = new Date(iso + 'T00:00:00');
        if (isNaN(then)) return '';
        const days = Math.round((then - today) / 86400000);
        if (days === 0) return 'today';
        if (days === 1) return 'tomorrow';
        return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    /** "7:05 AM", or '' for a date-only reservation. */
    function timeLabel(iso) {
        const m = /T(\d{2}):(\d{2})/.exec(iso || '');
        if (!m) return '';
        const h = +m[1];
        return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
    }

    /** "Aug 20 – 23" / "Aug 20 – Sep 3" / "Aug 20" */
    function rangeLabel(startISO, endISO) {
        const fmt = (iso, withMonth) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US',
            withMonth ? { month: 'short', day: 'numeric' } : { day: 'numeric' });
        if (startISO === endISO) return fmt(startISO, true);
        const sameMonth = startISO.slice(0, 7) === endISO.slice(0, 7);
        return `${fmt(startISO, true)} – ${fmt(endISO, !sameMonth)}`;
    }

    function nights(startISO, endISO) {
        const n = Math.round((new Date(endISO + 'T00:00:00') - new Date(startISO + 'T00:00:00')) / 86400000);
        return n > 0 ? n : 0;
    }

    /**
     * One row per leg. A round-trip flight is one insight but two rows —
     * the manifest lists journeys, and coming home is one of them.
     */
    function legRows(it) {
        const r = it.reservation;
        const a = it.analysis;
        const join = (parts) => parts.filter(Boolean).join(' · ');
        const flag = a.actionRequired ? 'Action' : (r.status === 'changed' ? 'Changed' : '');
        const row = (when, text) => ({
            when, flag,
            text: text || UIUtils.humanizeIsoDates(a.summary || 'Reservation'),
            id: it.id,
        });

        if (r.kind === 'flight' || r.kind === 'rail') {
            const out = [row(r.start, join([
                r.vendor,
                r.from && r.to ? `${r.from} → ${r.to}` : null,
                timeLabel(r.start),
            ]))];
            if (r.returnStart) {
                out.push(row(r.returnStart, join([
                    r.vendor,
                    r.from && r.to ? `${r.to} → ${r.from}` : 'return',
                    timeLabel(r.returnStart),
                ])));
            }
            return out;
        }
        if (r.kind === 'lodging') {
            const n = nights(it.span.start, it.span.end);
            return [row(r.start, join([
                r.vendor || r.place,
                n ? `${n} night${n === 1 ? '' : 's'}` : null,
            ]))];
        }
        if (r.kind === 'car') {
            return [row(r.start, join([r.vendor, r.vendor ? 'rental car' : 'Rental car', r.place]))];
        }
        // dining / event / other
        return [row(r.start, join([r.vendor || r.place, timeLabel(r.start)]))];
    }

    /** The card's doors all recompute from the same inputs, so an index is
     *  a stable enough handle across one render. */
    function liveTrips() {
        return EmailTrips.trips(EmailApp.getProfileAnalyses(), UIUtils.todayISO());
    }

    function openTripView(trip) {
        if (!trip || typeof FyiPage === 'undefined' || !FyiPage.openTrip) {
            AppManager.openApp('fyi');
            return;
        }
        FyiPage.openTrip(trip.items.map(it => it.id), EmailTrips.label(trip));
    }

    Widgets.register('trips', {
        kind: 'attention',
        title: 'Trips',
        // Rows open individual insights; the header and section heads open
        // the trip view in Email AI (FyiPage.openTrip).
        app: 'fyi',
        // Time-sensitive: the trip's own clock decides when the card leaves.
        order: 30,
        // The header door goes to the soonest trip's manifest, not just to
        // the Email AI page — landing on the page's overview lost the trip
        // the click was about. With several trips, each section head is its
        // own door to its own.
        onOpen() {
            openTripView(liveTrips()[0]);
        },
        load() {
            if (typeof EmailApp === 'undefined' || typeof EmailTrips === 'undefined') return null;
            if (!EmailApp.aiInsightsEnabled) return null;
            const blob = StorageManager.get('email');
            if (!Array.isArray(blob?.accounts) || !blob.accounts.length) return null;
            if (EmailApp._dataLoaded !== true) {
                if (!loading) {
                    loading = true;
                    EmailApp.loadData()
                        .catch((e) => console.warn('[trip widget] load failed:', e))
                        .finally(() => { loading = false; Widgets.refresh(); });
                }
                return null;
            }

            const today = UIUtils.todayISO();
            const trips = EmailTrips.trips(EmailApp.getProfileAnalyses(), today);
            if (!trips.length) return null;

            const esc = UIUtils.escapeHtml.bind(UIUtils);
            const single = trips.length === 1;
            let hidden = 0;

            const body = trips.map((trip, i) => {
                const rows = trip.items.flatMap(legRows)
                    .sort((x, y) => String(x.when).localeCompare(String(y.when)));
                const shown = rows.slice(0, MAX_ROWS);
                hidden += rows.length - shown.length;
                // Single trip: the title names it, the head line is its
                // dateline. Several: each section head names its own and is
                // the door to that trip's manifest.
                const head = single
                    ? `<div class="widget-trip-head">${esc(rangeLabel(trip.start, trip.end))}</div>`
                    : `<button type="button" class="widget-trip-head is-door"
                               data-w-action="trip" data-w-id="${i}"
                               title="Open this trip">${esc([trip.dest, rangeLabel(trip.start, trip.end)].filter(Boolean).join(' · '))}</button>`;
                return head
                    + Widgets.rows(shown.map(rw => ({
                        sub: dayLabel(String(rw.when).slice(0, 10), today),
                        text: rw.text,
                        flag: rw.flag,
                        actions: [{ label: 'Open', action: 'open', id: rw.id, title: 'Open this reservation' }],
                    })));
            }).join('');

            const active = trips.some(t => t.start <= today && today <= t.end);
            return {
                title: single ? EmailTrips.label(trips[0]) : 'Trips',
                count: single ? undefined : trips.length,
                body,
                footer: Widgets.more(hidden),
                // In progress is a good place to be; upcoming is just ink.
                tone: active ? 'good' : undefined,
            };
        },
        onAction(action, data) {
            if (action === 'open' && data.id) { FyiPage.openTo(data.id); return; }
            // Section-head door: recompute and index — same inputs within a
            // render, and a stale click after a data change still lands on
            // A trip rather than erroring.
            if (action === 'trip') openTripView(liveTrips()[Number(data.id) || 0]);
        },
    });
})();
