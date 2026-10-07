/**
 * EmailTrips — reservation insights clustered into trips, by arithmetic.
 *
 * A "trip" is a set of reservations whose date spans overlap or sit within
 * a day of each other: the flight arriving Aug 20, the hotel Aug 20–23 and
 * the dinner on the 21st chain into one span. The home Trips card renders
 * one section per live cluster and disappears when the last span passes.
 *
 * The rules, and why each is what it is:
 *
 * - **Facts are arithmetic** (the thread-membership / strategy-adherence
 *   law). Clustering is date arithmetic over the structured reservation
 *   records `_extractReservation` already validated — no model call, no
 *   judgment. The model's only contribution happened at extraction time.
 * - **Anchor rule**: a cluster is a Trip only if it holds a journey or a
 *   stay (flight / lodging / rail / car). A lone dinner reservation next
 *   Tuesday is not a trip — it stays a plain reservation row on the Email
 *   card. Dining/event/other reservations JOIN a trip by date; they never
 *   found one.
 * - **A round trip is the spine**: a flight's span runs to its return leg
 *   (`returnEnd`), so the one booking that knows the whole trip's length
 *   is what everything else chains into.
 * - **Destination splits adjacency, never overlap.** Two clusters that
 *   merely touch (gap ≤ CHAIN_GAP_DAYS, no shared day) stay separate when
 *   both name destinations that comparably differ — back-to-back trips to
 *   different cities. Overlapping spans always merge: the round-trip
 *   flight overlaps everything inside the trip by construction. "SEA" vs
 *   "Seattle" is incomparable (code vs city — no lookup table here), and
 *   incomparable means DON'T split: one card holding two trips is a
 *   lesser wrong than one trip cut in half.
 * - **Cancelled reservations are not on the trip.** `status` comes from
 *   the extraction; a cancellation email supersedes the booking row.
 * - **Done means the CLUSTER's end passed**, not the reservation's: mid-trip,
 *   Monday's dinner has passed but the trip manifest still lists it. The
 *   PAST_CHAIN_DAYS reach-back exists only so early legs of a long trip can
 *   still chain into the live tail.
 *
 * Pure functions of (analyses, todayISO) — no store, no DOM. The trip
 * widget and the Email card's dedup both call in here, so the two can
 * never disagree about which insight is "on a trip". Node-exported for
 * tests/trip-clusters-test.js.
 */
const EmailTrips = {
    // Spans within this many days of each other chain into one trip.
    CHAIN_GAP_DAYS: 1,
    // How far back a span may reach and still chain into a live trip.
    PAST_CHAIN_DAYS: 30,
    // Kinds that can FOUND a trip. Dining/event/other only ever join one.
    ANCHOR_KINDS: ['flight', 'lodging', 'rail', 'car'],
    // Kinds whose destination is `to` (a journey) rather than `place`.
    JOURNEY_KINDS: ['flight', 'rail'],

    /**
     * All live trips, soonest first — or, with opts.pastDays, finished
     * trips from that many days back too (the Email AI Bundles index shows
     * the retention window's worth; the home card never passes it, so it
     * stays an attention surface).
     * @param analyses  {emailId: analysis} — EmailApp.getProfileAnalyses()
     * @param todayISO  'YYYY-MM-DD' (injectable clock, the eval-harness rule)
     * @returns [{ start, end, dest, items: [{id, analysis, reservation, span}] }]
     */
    trips(analyses, todayISO, opts = {}) {
        const pastDays = Math.max(0, Number(opts.pastDays) || 0);
        const floor = this._addDays(todayISO, -Math.max(this.PAST_CHAIN_DAYS, pastDays));
        const items = [];
        for (const [id, a] of Object.entries(analyses || {})) {
            const r = a && a.reservation;
            if (!r || r.status === 'cancelled') continue;
            const span = this._span(r);
            if (!span || span.end < floor) continue;
            items.push({ id, analysis: a, reservation: r, span });
        }
        items.sort((x, y) => x.span.start.localeCompare(y.span.start)
            || x.span.end.localeCompare(y.span.end));

        const clusters = [];
        for (const it of items) {
            const cur = clusters[clusters.length - 1];
            if (cur && this._joins(cur, it)) {
                cur.items.push(it);
                if (it.span.end > cur.end) cur.end = it.span.end;
            } else {
                clusters.push({ start: it.span.start, end: it.span.end, items: [it] });
            }
        }

        const horizon = this._addDays(todayISO, -pastDays);
        return clusters
            .filter(c => c.end >= horizon)
            .filter(c => c.items.some(it => this.ANCHOR_KINDS.includes(it.reservation.kind)))
            .map(c => ({ ...c, dest: this._clusterDest(c) }));
    },

    /** The one builder of a trip's display name — widget, index and trip
     *  view all call this, so a trip cannot go by two names. */
    label(trip) {
        return trip && trip.dest ? `Trip · ${trip.dest}` : 'Trip';
    },

    /**
     * Email ids riding a live trip — what the Email card's dedup reads so a
     * reservation never sits on two cards at once (the representedByTask
     * bargain: say it once).
     */
    coveredIds(analyses, todayISO) {
        const ids = new Set();
        for (const c of this.trips(analyses, todayISO))
            for (const it of c.items) ids.add(it.id);
        return ids;
    },

    /**
     * A reservation's whole date span, date-only. Start is required (the
     * validator guarantees start-or-code; codeless-and-dateless never got
     * stored, code-only carries nothing to place on a timeline). End is the
     * latest of every date the record knows — for a round trip that is the
     * return leg, which is what makes the flight span the whole trip.
     */
    _span(r) {
        const day = (v) => {
            const s = String(v || '').slice(0, 10);
            return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
        };
        const start = day(r.start);
        if (!start) return null;
        const end = [r.returnEnd, r.returnStart, r.end, r.start]
            .map(day).filter(Boolean).sort().pop();
        return { start, end: end > start ? end : start };
    },

    _joins(cluster, it) {
        // Items arrive start-sorted, so overlap is one comparison.
        if (it.span.start <= cluster.end) return true;
        if (it.span.start > this._addDays(cluster.end, this.CHAIN_GAP_DAYS)) return false;
        // Adjacent, not overlapping: different named destinations mean
        // different trips.
        return this._sameDest(this._clusterDest(cluster), this._dest(it.reservation));
    },

    _dest(r) {
        return this.JOURNEY_KINDS.includes(r.kind)
            ? (r.to || r.place) : (r.place || r.to);
    },

    /**
     * The name a trip goes by: the stay's place beats a journey's `to`
     * (hotels say "Seattle", flights say "SEA"), city-ish beats airport
     * code, first item breaks ties. Null when nothing names one.
     */
    _clusterDest(cluster) {
        const dests = cluster.items.map(it => this._dest(it.reservation)).filter(Boolean);
        if (!dests.length) return null;
        const lodging = cluster.items.find(it =>
            it.reservation.kind === 'lodging' && it.reservation.place);
        if (lodging) return lodging.reservation.place;
        return dests.find(d => !this._isCode(d)) || dests[0];
    },

    _isCode(s) {
        return /^[A-Z]{3}$/.test(String(s || '').trim());
    },

    /**
     * Same destination? Errs toward YES: null or code-vs-city is
     * incomparable, and incomparable must not split a trip. City names
     * match on containment so "Seattle, WA" and "Seattle" agree.
     */
    _sameDest(a, b) {
        if (!a || !b) return true;
        const ca = this._isCode(a), cb = this._isCode(b);
        if (ca !== cb) return true;
        const norm = (s) => String(s).toLowerCase().trim();
        const na = norm(a), nb = norm(b);
        if (ca) return na === nb;
        return na.includes(nb) || nb.includes(na);
    },

    _addDays(iso, n) {
        // Noon dodges DST; the slice keeps it date-only.
        const d = new Date(iso + 'T12:00:00');
        d.setDate(d.getDate() + n);
        const p = (x) => String(x).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = EmailTrips;
