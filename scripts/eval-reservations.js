#!/usr/bin/env node
/**
 * eval-reservations.js — the phase 3 gate for docs/LIFE_ORG.md.
 *
 * Runs EmailApp._extractReservation (the real one, through the real local
 * model) over a corpus and scores it per field, so "does the 12B floor hold
 * for a ten-field extraction?" has a number instead of an opinion.
 *
 * Two modes:
 *
 *   --fixtures            scripts/fixtures/reservations.json — synthetic mail
 *                         with known answers. Scored automatically. This is a
 *                         FLOOR, not the gate: the fixtures are cleaner than
 *                         real vendor mail because I wrote them.
 *
 *   --store <dataRoot>    every booking-typed insight in a real store. There
 *                         are no expected values, so this prints a review
 *                         table plus coverage counts for a human to judge,
 *                         and writes the raw extractions to JSON.
 *
 * THE GATE is --store over 20 real confirmations across 6+ vendors. Point it
 * at a COPY of a mailbox, never the live one:
 *
 *   cp -R ~/Library/Application\\ Support/Anjadhe /tmp/anjadhe-eval
 *   node scripts/eval-reservations.js --store /tmp/anjadhe-eval
 *
 * Requires playwright-core (keep it OUT of this repo's package.json — install
 * it in a scratch dir and run with NODE_PATH, same as the verify skill).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const MODE_STORE = args.includes('--store');
const MODEL = argValue('--model') || 'gemma4:12b-it-qat';
const OUT = argValue('--out');
const LIMIT = parseInt(argValue('--limit') || '0', 10);

function argValue(flag) {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

let DATA_ROOT = MODE_STORE ? argValue('--store') : (argValue('--root') || '/tmp/anjadhe-reservation-eval');
if (!DATA_ROOT) {
    console.error('--store needs a data root. See the header of this file.');
    process.exit(1);
}
DATA_ROOT = path.resolve(DATA_ROOT.replace(/^~(?=$|\/)/, os.homedir()));

// Same guard as seed-demo-data.js. This script drives the whole app, which
// runs its own timers and save paths against whatever store it opens.
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'Anjadhe');
if (DATA_ROOT === realUserData || realUserData.startsWith(DATA_ROOT + path.sep)) {
    console.error('Refusing to run against the real app data location: ' + DATA_ROOT);
    console.error('Copy it first:  cp -R "' + realUserData + '" /tmp/anjadhe-eval');
    process.exit(1);
}

const { _electron } = require('playwright-core');

const FIELDS = ['kind', 'vendor', 'confirmationCode', 'start', 'end', 'returnStart',
    'returnEnd', 'from', 'to', 'place', 'status', 'cancelBy'];

(async () => {
    const app = await _electron.launch({
        executablePath: REPO + '/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        args: [REPO],
        cwd: REPO,
        env: { ...process.env, ANJADHE_DATA_ROOT: DATA_ROOT },
    });
    const page = await app.firstWindow();
    page.on('pageerror', e => console.error('PAGEERROR:', e.message));

    await page.waitForTimeout(4000);
    await page.evaluate(() => window.electronStore.markSetupComplete());
    await page.reload();
    await page.waitForTimeout(4000);

    // Point the app at the local model and wait for llama-server to be up.
    // The first call after a cold start pays the model load, which on a 12B
    // is tens of seconds — that is the run, not a hang.
    await page.evaluate((m) => AgentService.setGlobalModel(m), MODEL);
    console.log(`model: ${MODEL}  (first call loads it; be patient)\n`);

    const corpus = MODE_STORE ? await loadFromStore(page) : loadFixtures();
    if (!corpus.length) {
        console.error(MODE_STORE ? 'No booking-typed insights in that store.' : 'No fixtures.');
        await app.close();
        process.exit(1);
    }
    const cases = LIMIT ? corpus.slice(0, LIMIT) : corpus;
    console.log(`${cases.length} case${cases.length === 1 ? '' : 's'}\n`);

    const results = [];
    for (const c of cases) {
        const t0 = Date.now();
        // Capture the model's raw text alongside the validated result. A bare
        // "got null" is useless for diagnosis — it could be an empty
        // response, unparseable JSON, or validation correctly rejecting a
        // hallucination, and those need different fixes.
        const { got, raw } = await page.evaluate(async ({ email, today }) => {
            let raw = null;
            const orig = LLMLogger.call.bind(LLMLogger);
            LLMLogger.call = async (tag, o) => {
                const r = await orig(tag, o);
                if (tag === 'email-reservation') raw = r?.message?.content ?? null;
                return r;
            };
            try {
                const got = await EmailApp._extractReservation(email, {}, { today });
                return { got, raw };
            } catch (e) {
                return { got: null, raw: `THREW: ${e && e.message}` };
            } finally {
                LLMLogger.call = orig;
            }
        }, { email: c.email, today: c.today || null });
        results.push({ c, got, raw, ms: Date.now() - t0 });
        process.stdout.write(got ? '.' : '!');
    }
    console.log('\n');

    if (MODE_STORE) reportStore(results);
    else reportFixtures(results);

    if (OUT) {
        fs.writeFileSync(OUT, JSON.stringify(results.map(r => ({
            id: r.c.id, subject: r.c.email.subject, from: r.c.email.from,
            extracted: r.got, ms: r.ms,
        })), null, 2));
        console.log(`\nraw extractions → ${OUT}`);
    }

    await app.close();
    process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

// ── Corpora ──────────────────────────────────────────────────────────────

function loadFixtures() {
    const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/reservations.json'), 'utf8'));
    return f.cases.map(c => ({
        id: c.id,
        today: f.today,
        expect: c.expect || {},
        expectOneOf: c.expectOneOf || {},
        expectNull: !!c.expectNull,
        note: c.note,
        email: {
            messageId: 'fixture-' + c.id, subject: c.subject, from: c.from,
            to: 'me@example.com', date: new Date(f.today + 'T09:00:00Z').toISOString(),
            bodyText: c.body, snippet: c.body.slice(0, 200), labels: ['INBOX'],
        },
    }));
}

async function loadFromStore(page) {
    return page.evaluate(async () => {
        await EmailApp.loadData();
        // Read-only, but freeze the write paths anyway — this script drives
        // the live app object and a stray save is how a store gets damaged.
        EmailApp.saveData = () => {};
        EmailApp._persistAnalyses = async () => {};
        EmailApp.deltaSync = async () => {};
        EmailApp.stopSmartSync?.();

        // Select by the booking LEXICON, not by the stored analysis type.
        // The `booking` type only exists as of 2026-08-02, and
        // retriageAfterLexiconChange deliberately skips mail that already
        // carries an analysis — so every confirmation already in a real
        // mailbox is still filed as `appointment` or `general`. Selecting on
        // type would find nothing and the gate could not be run until enough
        // NEW travel mail arrived. The lexicon finds the archive today.
        const seen = new Set();
        const picked = [];
        const sorted = [...EmailApp.emails].sort((a, b) => EmailApp._emailTime(b) - EmailApp._emailTime(a));
        for (const e of sorted) {
            if (!e?.messageId) continue;
            const scored = EmailApp._scoreEmail(e);
            const isBooking = scored.types.includes('booking')
                || EmailApp.priorityAnalyses[e.messageId]?.type === 'booking';
            if (!isBooking) continue;
            // One per sender, so twenty United emails don't crowd out five
            // other vendors — the gate is "6+ vendors", and a corpus of one
            // airline measures one airline.
            const addr = EmailApp.senderAddress(e) || e.from || '';
            if (seen.has(addr)) continue;
            seen.add(addr);
            await EmailApp._ensureBody(e);
            picked.push({
                id: e.messageId,
                vendor: addr,
                email: {
                    messageId: e.messageId, subject: e.subject, from: e.from,
                    to: e.to, date: e.date, bodyText: e.bodyText || e.snippet || '',
                    snippet: e.snippet, labels: e.labels,
                },
            });
        }
        return picked;
    });
}

// ── Reports ──────────────────────────────────────────────────────────────

function reportFixtures(results) {
    // Per field: correct / wrong / missed (null when a value was expected) /
    // hallucinated (a value when null was expected). The last two are split
    // because they are different failures — a miss degrades a row, a
    // hallucination puts a wrong confirmation code in front of a traveller.
    const tally = {};
    for (const f of FIELDS) tally[f] = { correct: 0, wrong: 0, missed: 0, hallucinated: 0, n: 0 };
    let caseFails = 0;

    for (const { c, got, raw } of results) {
        const problems = [];

        if (c.expectNull) {
            if (got) problems.push(`expected NO reservation, got ${JSON.stringify(got)}`);
        } else if (!got) {
            problems.push('expected a reservation, got null');
            problems.push(`  model said: ${raw === null ? '(empty response)' : JSON.stringify(String(raw).slice(0, 400))}`);
            for (const f of Object.keys(c.expect)) { tally[f].n++; tally[f].missed++; }
        } else {
            for (const [f, want] of Object.entries(c.expect)) {
                const alts = c.expectOneOf[f];
                const have = got[f] ?? null;
                const ok = alts ? alts.includes(have) : eq(have, want);
                tally[f].n++;
                if (ok) tally[f].correct++;
                else if (want !== null && have === null) { tally[f].missed++; problems.push(`${f}: missed (want ${want})`); }
                else if (want === null && have !== null) { tally[f].hallucinated++; problems.push(`${f}: HALLUCINATED ${JSON.stringify(have)}`); }
                else { tally[f].wrong++; problems.push(`${f}: got ${JSON.stringify(have)}, want ${JSON.stringify(want)}`); }
            }
        }

        if (problems.length) caseFails++;
        console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${c.id}`);
        for (const p of problems) console.log(`        ${p}`);
        if (problems.length && c.note) console.log(`        (${c.note})`);
    }

    console.log('\nper-field');
    console.log('  field              n   ok  wrong  missed  halluc');
    for (const f of FIELDS) {
        const t = tally[f];
        if (!t.n) continue;
        console.log(`  ${f.padEnd(16)}${String(t.n).padStart(4)}${String(t.correct).padStart(5)}`
            + `${String(t.wrong).padStart(7)}${String(t.missed).padStart(8)}${String(t.hallucinated).padStart(8)}`);
    }
    const n = results.length;
    const totals = FIELDS.reduce((a, f) => {
        a.n += tally[f].n; a.correct += tally[f].correct; a.halluc += tally[f].hallucinated; return a;
    }, { n: 0, correct: 0, halluc: 0 });
    console.log(`\ncases: ${n - caseFails}/${n} clean`);
    console.log(`fields: ${totals.correct}/${totals.n} correct (${pct(totals.correct, totals.n)})`);
    console.log(`hallucinated: ${totals.halluc}`);
    const slow = results.reduce((a, r) => a + r.ms, 0) / n;
    console.log(`mean latency: ${(slow / 1000).toFixed(1)}s`);
}

function reportStore(results) {
    const cov = {};
    for (const f of FIELDS) cov[f] = 0;
    let nulls = 0;
    for (const { got } of results) {
        if (!got) { nulls++; continue; }
        for (const f of FIELDS) if (got[f] !== null && got[f] !== undefined) cov[f]++;
    }
    const vendors = new Set(results.map(r => r.c.vendor).filter(Boolean));
    console.log(`${results.length} confirmations from ${vendors.size} vendor${vendors.size === 1 ? '' : 's'}.`);
    console.log('The gate wants 20 across 6+. Review these by eye — real mail has no expected values.\n');
    for (const { c, got } of results) {
        console.log(`— ${c.email.subject}`);
        console.log(`  from ${c.email.from}`);
        console.log(got ? '  ' + FIELDS.filter(f => got[f] != null).map(f => `${f}=${got[f]}`).join('  ') : '  (no reservation extracted)');
    }
    const n = results.length;
    console.log(`\nextracted: ${n - nulls}/${n}`);
    console.log('field coverage (non-null):');
    for (const f of FIELDS) console.log(`  ${f.padEnd(16)} ${String(cov[f]).padStart(3)}/${n}  ${pct(cov[f], n)}`);
    console.log('\nCoverage is not correctness. Read the rows above before recording a number in docs/LIFE_ORG.md.');
}

function eq(a, b) {
    if (a === null || b === null) return a === b;
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
function pct(a, b) { return b ? `${Math.round((a / b) * 100)}%` : '-'; }
