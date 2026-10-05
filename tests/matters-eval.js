#!/usr/bin/env node
/**
 * Matters eval — the two numbers behind docs/MATTERS.md §15: DUPLICATES MADE
 * (two folders for one real thing) and MAJORS MISSED (a thing that should
 * have a folder and has none, or was folded into another thing's folder).
 * They are the gate for turning on new sources.
 *
 * Runs the app's OWN door (Matters.observe / file, the second look, tidy,
 * MatterCapture) against a local OpenAI-compatible server; only the model
 * transport, the store and the calendar/tasks are stubbed. Fixtures are
 * SYNTHETIC (never real mail) and dated relative to today.
 *
 * Start a server first, e.g.:
 *   ~/.nenva_llamacpp/engine/llama-server -m <model>.gguf --port 8097 -c 8192 --jinja
 * then:
 *   MATTERS_PORT=8097 MATTERS_MODEL=nenva-local node tests/matters-eval.js [--only s1,s5] [--verbose]
 *
 * "preview" scenarios exercise sources that are not wired yet (the person's
 * own words in a general chat); they are reported, never counted in the gate.
 */
const http = require('http');
const PORT = Number(process.env.MATTERS_PORT) || 8097;
const HOST = process.env.MATTERS_HOST || '127.0.0.1';
const MODEL = process.env.MATTERS_MODEL || 'nenva-local';
const VERBOSE = process.argv.includes('--verbose');
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? new Set(String(process.argv[i + 1] || '').split(',')) : null; })();

// ── The app, with only its edges stubbed ──
let blob = null;
global.StorageManager = { get: () => blob, set: (_k, v) => { blob = v; } };
global.AgentService = { model: MODEL, numCtx: 8192 };
let calls = 0;
global.LLMLogger = {
    call: (tag, p) => new Promise((resolve) => {
        calls++;
        const body = JSON.stringify({ model: p.model, messages: p.messages, temperature: (p.options && p.options.temperature) || 0.1, max_tokens: p.maxTokens || 600,
            stream: false, ...(p.format === 'json' ? { response_format: { type: 'json_object' } } : {}), chat_template_kwargs: { enable_thinking: false } });
        const req = http.request({ host: HOST, port: PORT, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try { const j = JSON.parse(data); const content = j.choices[0].message.content; if (VERBOSE) console.log(`    [${tag}] ${String(content).replace(/\s+/g, ' ').slice(0, 300)}`); resolve({ message: { content } }); }
                catch (e) { resolve({ error: `bad answer: ${String(data).slice(0, 120)}` }); }
            });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.end(body);
    })
};
const Matters = require('../js/core/matters.js');
global.Matters = Matters;
const MatterCapture = require('../js/agent/matter-capture.js');
const MatterSources = require('../js/core/matter-sources.js');
Matters._changed = () => {};

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const human = d => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const ago = h => new Date(Date.now() - h * 3600000).toISOString();

let seq = 0;
const mail = (from, subject, body, analysis = {}, hoursAgo = 1) => ({ msg: { messageId: `ev-${++seq}`, from, subject, bodyText: body, date: ago(hoursAgo), threadId: analysis.thread || `th-${seq}` }, analysis: { summary: analysis.summary || subject, ...analysis } });
const text = (handle, body, analysis = {}, hoursAgo = 1) => ({ msg: { messageId: `ev-${++seq}`, source: 'imessage', from: handle, subject: '', bodyText: body, date: ago(hoursAgo), chat: { handle, key: `chat-${handle}` } }, analysis: { summary: analysis.summary || body.slice(0, 120), ...analysis } });
const said = (words, dates = []) => ({ own: Matters.observation({ id: `chat:eval:${++seq}`, source: 'chat', at: new Date().toISOString(), text: words, summary: words.slice(0, 200), dates }) });

const D = { appt: inDays(9), crown: inDays(40), bill: inDays(8), flight: inDays(21), slip: inDays(6), jury: inDays(30), hoa: inDays(12), surgery: inDays(9), renew: inDays(15) };

/**
 * A scenario: observations filed in order into a fresh store, then `things`
 * (how many folders there should be) and optional `check(folders)` returning
 * a problem string. `none: true` rows are things that must NOT become folders.
 */
const SCENARIOS = [
    { id: 's1', name: 'one dentist visit reached four ways', things: 1, steps: [
        mail('Okafor Family Dental <office@okafordental.example>', 'Your appointment is booked', `Hi Jordan, your cleaning with Dr. Okafor is booked for ${human(D.appt)} at 10:30 AM at 12 Main St. Please reply to confirm.`, { type: 'appointment', eventDate: iso(D.appt), summary: `Cleaning with Dr. Okafor on ${human(D.appt)} at 10:30 AM`, actionItems: [{ text: 'Confirm the appointment' }] }, 50),
        text('+15550102000', `Okafor Family Dental: reminder, your visit is ${human(D.appt)} 10:30AM. Reply C to confirm.`, { type: 'appointment', eventDate: iso(D.appt), summary: `Reminder of dental visit ${human(D.appt)} 10:30, reply C to confirm` }, 30),
        mail('PatientPortal <no-reply@carestack.example>', 'New message from Okafor Family Dental', 'You have new forms to complete before your upcoming visit. Sign in to the portal to fill them in. https://portal.carestack.example/forms', { type: 'general', summary: 'Forms to complete before the upcoming visit at Okafor Family Dental', actionItems: [{ text: 'Complete the patient forms' }] }, 20),
        mail('Okafor Family Dental <office@okafordental.example>', 'See you tomorrow', `A reminder that we will see you on ${human(D.appt)} at 10:30 AM. Please arrive 10 minutes early.`, { type: 'appointment', eventDate: iso(D.appt), summary: `Reminder: visit ${human(D.appt)} 10:30 AM` }, 2)
    ] },
    { id: 's2', name: 'two different visits to the same dentist', things: 2, steps: [
        mail('Okafor Family Dental <office@okafordental.example>', 'Your appointment is booked', `Your cleaning with Dr. Okafor is booked for ${human(D.appt)} at 10:30 AM.`, { type: 'appointment', eventDate: iso(D.appt), summary: `Cleaning with Dr. Okafor on ${human(D.appt)} 10:30 AM` }, 40),
        mail('Okafor Family Dental <office@okafordental.example>', 'Crown fitting scheduled', `We have scheduled your crown fitting for ${human(D.crown)} at 2:00 PM. This is a separate visit from your cleaning.`, { type: 'appointment', eventDate: iso(D.crown), summary: `Crown fitting on ${human(D.crown)} 2:00 PM` }, 5)
    ] },
    { id: 's3', name: 'a bill, its reminder and its payment', things: 1, check: f => (f[0].state === 'done' ? null : `bill is ${f[0].state}, expected done`), steps: [
        mail('Lakeside Water <billing@lakesidewater.example>', 'Your statement is ready', `Account 88001234. Amount due $41.20 by ${human(D.bill)}. Pay at https://pay.lakesidewater.example/88001234`, { type: 'bill', amount: '$41.20', eventDate: iso(D.bill), summary: `Water bill $41.20 due ${human(D.bill)}`, actionItems: [{ text: 'Pay the water bill', dueDate: iso(D.bill) }] }, 60),
        mail('Lakeside Water <billing@lakesidewater.example>', 'Reminder: payment due soon', `Account 88001234: your payment of $41.20 is due ${human(D.bill)}.`, { type: 'bill', amount: '$41.20', eventDate: iso(D.bill), summary: `Reminder: $41.20 due ${human(D.bill)}` }, 20),
        mail('Lakeside Water <billing@lakesidewater.example>', 'Payment received', 'Thank you. We received your payment of $41.20 for account 88001234.', { type: 'receipt', amount: '$41.20', summary: 'Payment of $41.20 received' }, 1)
    ] },
    { id: 's4', name: 'last month\'s bill (paid) and this month\'s', things: 2, steps: [
        mail('Lakeside Water <billing@lakesidewater.example>', 'Your September statement', 'Account 88001234. September charges $38.75, due September 28.', { type: 'bill', amount: '$38.75', summary: 'September water bill $38.75' }, 400),
        mail('Lakeside Water <billing@lakesidewater.example>', 'Payment received', 'We received your payment of $38.75 for your September statement. Account 88001234.', { type: 'receipt', amount: '$38.75', summary: 'September payment of $38.75 received' }, 300),
        mail('Lakeside Water <billing@lakesidewater.example>', 'Your October statement', `Account 88001234. October charges $41.20, due ${human(D.bill)}.`, { type: 'bill', amount: '$41.20', eventDate: iso(D.bill), summary: `October water bill $41.20 due ${human(D.bill)}`, actionItems: [{ text: 'Pay the water bill', dueDate: iso(D.bill) }] }, 3)
    ] },
    { id: 's5', name: 'an order from the shop, the carrier and the doorstep', things: 1, steps: [
        mail('Fernwood Goods <orders@fernwood.example>', 'Order #FW-204418 confirmed', 'Thanks for your order #FW-204418: 1 x cast iron skillet. Total $64.00. We will email you when it ships.', { type: 'order', amount: '$64.00', summary: 'Order FW-204418 confirmed: cast iron skillet, $64.00' }, 70),
        mail('ParcelPath <track@parcelpath.example>', 'A package from Fernwood Goods is on its way', 'Tracking 1Z999AA10123456784. Your package from Fernwood Goods (order FW-204418) is out for delivery tomorrow.', { type: 'order', summary: 'Package from Fernwood Goods on its way, order FW-204418' }, 30),
        mail('ParcelPath <track@parcelpath.example>', 'Delivered', 'Your package from Fernwood Goods (tracking 1Z999AA10123456784) was delivered to your front door.', { type: 'order', summary: 'Package from Fernwood Goods delivered' }, 2)
    ] },
    { id: 's6', name: 'noise: a newsletter, a sign-in code, a promo', things: 0, steps: [
        mail('The Morning Brief <news@morningbrief.example>', 'Five things to know today', 'Markets rose, a storm is coming, and three more stories. Read online.', { type: 'general', summary: 'Daily newsletter' }),
        mail('Streamly <no-reply@streamly.example>', 'Your sign-in code', 'Your code is 448201. It expires in 10 minutes.', { type: 'code', summary: 'Sign-in code' }),
        mail('Fernwood Goods <deals@fernwood.example>', '20% off everything this weekend', 'Our autumn sale is on. Use code FALL20 at checkout. Ends Sunday.', { type: 'general', summary: 'Weekend sale, 20% off' })
    ] },
    { id: 's7', name: 'majors written plainly: a permission slip, jury duty, an HOA deadline', things: 3, steps: [
        mail('Ms. Alvarez <alvarez@maplegrove-elementary.example>', 'Field trip next week', `Hello families, our class visits the science museum next week. Please sign and return the permission slip by ${human(D.slip)} or your child will not be able to come. Thanks!`, { type: 'general', eventDate: iso(D.slip), summary: `Field trip permission slip due ${human(D.slip)}`, actionItems: [{ text: 'Sign and return the permission slip', dueDate: iso(D.slip) }] }),
        mail('Superior Court Jury Services <jury@countycourt.example>', 'Summons for jury service', `You are summoned for jury service beginning ${human(D.jury)} at 8:00 AM, 400 Court St. Group number 2217. You must respond online within 5 days.`, { type: 'general', eventDate: iso(D.jury), summary: `Jury duty summons for ${human(D.jury)}; respond within 5 days`, actionItems: [{ text: 'Respond to the jury summons' }] }),
        mail('Birchwood HOA <board@birchwoodhoa.example>', 'Notice: exterior paint approval', `The board has approved the repainting schedule. Owners must choose a colour from the approved list by ${human(D.hoa)}; units with no choice will be assigned one.`, { type: 'general', eventDate: iso(D.hoa), summary: `Choose an exterior paint colour by ${human(D.hoa)}`, actionItems: [{ text: 'Choose a paint colour', dueDate: iso(D.hoa) }] })
    ] },
    { id: 's8', name: 'a flight: booked, changed, check-in', things: 1, steps: [
        mail('Cascade Air <reservations@cascadeair.example>', 'Your trip is confirmed', `Confirmation K7Q2ZP. Flight CA 412 to Seattle (SEA) departs ${human(D.flight)} at 8:05 AM.`, { type: 'reservation', eventDate: iso(D.flight), summary: `Flight CA 412 to Seattle on ${human(D.flight)} 8:05 AM`, reservation: { kind: 'flight', vendor: 'Cascade Air', confirmationCode: 'K7Q2ZP', to: 'SEA', start: `${iso(D.flight)}T08:05` } }, 90),
        mail('Cascade Air <alerts@cascadeair.example>', 'Schedule change to your flight', `Confirmation K7Q2ZP: flight CA 412 on ${human(D.flight)} now departs at 9:40 AM instead of 8:05 AM.`, { type: 'reservation', eventDate: iso(D.flight), summary: `Flight CA 412 now departs 9:40 AM on ${human(D.flight)}`, reservation: { kind: 'flight', vendor: 'Cascade Air', confirmationCode: 'K7Q2ZP', to: 'SEA', start: `${iso(D.flight)}T09:40` } }, 20),
        mail('Cascade Air <checkin@cascadeair.example>', 'Time to check in', 'Check in now for your flight to Seattle. Confirmation K7Q2ZP. https://cascadeair.example/checkin/K7Q2ZP', { type: 'reservation', summary: 'Check-in is open for the Seattle flight', reservation: { kind: 'flight', vendor: 'Cascade Air', confirmationCode: 'K7Q2ZP' } }, 1)
    ] },
    { id: 's9', name: 'two unrelated appointments on the same day', things: 2, steps: [
        mail('Okafor Family Dental <office@okafordental.example>', 'Your appointment is booked', `Your cleaning with Dr. Okafor is booked for ${human(D.appt)} at 10:30 AM.`, { type: 'appointment', eventDate: iso(D.appt), summary: `Cleaning with Dr. Okafor on ${human(D.appt)} 10:30 AM` }, 30),
        text('+15550177000', `Shear Bliss Salon: you're booked for a haircut with Dana on ${human(D.appt)} at 4:15 PM. Reply STOP to opt out.`, { type: 'appointment', eventDate: iso(D.appt), summary: `Haircut with Dana ${human(D.appt)} 4:15 PM` }, 4)
    ] },
    { id: 's10', name: 'one bill seen from the biller and from the bank\'s bill-pay', things: 1, steps: [
        mail('Northwind Energy <billing@northwindenergy.example>', 'Your bill is ready', `Your Northwind Energy bill of $96.40 is due ${human(D.bill)}.`, { type: 'bill', amount: '$96.40', eventDate: iso(D.bill), summary: `Northwind Energy bill $96.40 due ${human(D.bill)}`, actionItems: [{ text: 'Pay the energy bill', dueDate: iso(D.bill) }] }, 40),
        mail('Harbor Bank Bill Pay <alerts@harborbank.example>', 'A bill is due soon: Northwind Energy', `Your e-bill from Northwind Energy for $96.40 is due ${human(D.bill)}. Sign in to schedule a payment.`, { type: 'bill', amount: '$96.40', eventDate: iso(D.bill), summary: `E-bill from Northwind Energy $96.40 due ${human(D.bill)}` }, 6)
    ] },
    { id: 's11', name: 'a subscription renewal and an unrelated receipt from the same company', things: 1, steps: [
        mail('Streamly <billing@streamly.example>', 'Your plan renews soon', `Your Streamly Premium plan renews on ${human(D.renew)} for $17.99, up from $14.99.`, { type: 'subscription', amount: '$17.99', eventDate: iso(D.renew), summary: `Streamly Premium renews ${human(D.renew)} at $17.99 (was $14.99)` }, 30),
        mail('Streamly <receipts@streamly.example>', 'Receipt for your rental', 'You rented "The Long Tide" for $3.99. Enjoy the film.', { type: 'receipt', amount: '$3.99', summary: 'Rental receipt $3.99', none: true }, 2)
    ], check: f => (f[0].sources.length === 1 ? null : 'the rental receipt was folded into the renewal') },
    { id: 'p1', name: 'preview: what the person says in a general chat', preview: true, things: 2, steps: [
        said(`my mom's surgery is on ${human(D.surgery)}, I need to take that day off`, [iso(D.surgery)]),
        said('remind me to buy milk on the way home'),
        said('I am switching car insurance next month and still have to compare quotes'),
        said('what is the weather like in Lisbon in March?')
    ] }
];

/** The tidy: two real duplicates and two look-alikes that are different things. */
async function tidyScenario() {
    blob = null; Matters._data = null; Matters._tidying = false;
    const d = Matters._load();
    const at = ago(30);
    const put = (id, kind, title, status, date, time, from, summary) => { d.matters[id] = { id, kind, state: 'open', title, status, when: { date, time }, ids: [], createdAt: at, updatedAt: at, next: null, sources: [{ id: id.slice(7), kind: 'email', at, from, summary }] }; };
    put('matter:a1', 'appointment', 'Cleaning with Dr. Okafor', 'Waiting for you to confirm', iso(D.appt), '10:30', 'Okafor Family Dental', `Cleaning ${human(D.appt)} 10:30 AM`);
    put('matter:a2', 'appointment', 'Okafor Family Dental visit', 'Forms to complete', iso(D.appt), null, 'PatientPortal', 'Forms to complete before your visit at Okafor Family Dental');
    put('matter:b1', 'order', 'Skillet from Fernwood Goods', 'Out for delivery', iso(inDays(1)), null, 'Fernwood Goods', 'Order FW-204418: cast iron skillet');
    put('matter:b2', 'order', 'Candles from Fernwood Goods', 'Confirmed', iso(inDays(2)), null, 'Fernwood Goods', 'Order FW-204977: two beeswax candles');
    const found = Matters.pairs(Matters.all()).map(p => [p.a.id, p.b.id].sort().join('+'));
    const before = calls;
    await Matters.tidy(Date.now());
    const left = Matters.all().map(m => m.id).sort();
    const dentistJoined = !left.includes('matter:a2') || !left.includes('matter:a1');
    const ordersKept = left.includes('matter:b1') && left.includes('matter:b2');
    return { id: 't1', name: 'tidy: a duplicate pair and a look-alike pair', found, calls: calls - before, dup: dentistJoined ? 0 : 1, missed: ordersKept ? 0 : 1,
        note: `${dentistJoined ? 'duplicate joined' : 'DUPLICATE LEFT'}; ${ordersKept ? 'two orders kept apart' : 'TWO ORDERS WRONGLY JOINED'}` };
}

/** What the person says in a folder's chat: the judgment MatterCapture asks for, then its own checks. */
const SAID = [
    { say: 'I paid that yesterday', want: ['done'] },
    { say: 'how much is it again?', want: [null] },
    { say: `they pushed the due date to ${human(inDays(16))}`, want: ['changed'], when: iso(inDays(16)) },
    { say: 'just ignore it for now', want: [null] },
    { say: 'fyi my landlord covers half of this one', want: ['same', 'changed', null] },
    { say: 'ok thanks', want: [null] },
    { say: 'I cancelled the service, there is nothing to pay anymore', want: ['cancelled', 'done'] }
];
async function chatScenario() {
    const bill = { id: 'matter:w1', kind: 'bill', state: 'open', title: 'Lakeside Water bill', status: `Due ${human(D.bill)}`, amount: '$41.20', when: { date: iso(D.bill), time: null },
        next: { what: 'Pay $41.20', state: 'open', how: 'none', yours: true }, sources: [{ kind: 'email', from: 'Lakeside Water', summary: `Water bill $41.20 due ${human(D.bill)}` }] };
    const rows = [];
    for (const c of SAID) {
        const res = await LLMLogger.call('matter-chat', { model: MODEL, format: 'json', maxTokens: 300, options: { temperature: 0.1 },
            messages: [{ role: 'system', content: 'You are the person\'s personal assistant. You answer with JSON only.' }, { role: 'user', content: MatterCapture._prompt(bill, c.say, null) }] });
        let raw = null;
        try { raw = JSON.parse(String(res.message.content).replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim()); } catch { raw = null; }
        const j = MatterCapture.vet(raw, bill, c.say);
        const got = j ? j.change : null;
        const ok = c.want.includes(got) && (!c.when || (j && j.when === c.when));
        rows.push({ say: c.say, got: got || 'nothing', when: j && j.when, ok });
    }
    return rows;
}

/**
 * The person's own tasks and events as sources (flag `mattersources`, off):
 * the triage, then the door. Reported on their own line, outside the gate.
 */
const task = (id, title, when = null, note = '') => ({ key: `c:${id}`, kind: 'commitment', id, title, when, note });
const event = (id, title, d, time = null, note = '') => ({ key: `e:${id}`, kind: 'calendar', id, title, when: iso(d), time, note });
async function sourcesScenario() {
    const rows = [];
    // o1: which tasks are a real thing.
    {
        blob = null; Matters._data = null;
        const items = [task('t1', 'Buy milk'), task('t2', 'Renew passport', iso(inDays(25)), 'expires in March, need new photos'), task('t3', 'Call mom'),
            task('t4', 'Book a venue for Maya\'s 5th birthday party', iso(inDays(18))), task('t5', 'Take out the recycling'),
            task('t6', 'Take the day off for mom\'s surgery', iso(D.surgery)), task('t7', 'Finish the Q3 slides'), task('t8', 'Dispute the double charge with Northwind Energy')];
        const must = [1, 3, 5, 7], never = [0, 2, 4];
        const before = calls;
        const keep = await MatterSources.triage(items, 'commitment') || [];
        const missed = must.filter(i => !keep.includes(i)), noise = never.filter(i => keep.includes(i));
        rows.push({ id: 'o1', name: 'triage: which of eight tasks are a real thing', calls: calls - before, dup: noise.length, missed: missed.length,
            note: `kept ${keep.map(i => items[i].title).join(' | ') || 'none'}${missed.length ? ` · MISSED ${missed.map(i => items[i].title).join(' | ')}` : ''}${noise.length ? ` · NOISE ${noise.map(i => items[i].title).join(' | ')}` : ''}` });
    }
    // o2: a calendar event and a task about a thing mail already opened join its folder; a new thing gets its own; lunch gets none.
    {
        blob = null; Matters._data = null;
        const first = SCENARIOS[0].steps[0];
        await Matters.file({ ...first.msg, messageId: 'ev-o2' }, { ...first.analysis });
        const before = calls;
        const seen = {};
        const evs = [event('e1', 'Dentist - cleaning', D.appt, '10:30', 'at 12 Main St'), event('e2', 'Lunch with Sam', inDays(3), '12:30'), event('e3', 'Mom surgery - St. Mary Hospital', D.surgery, '07:00')];
        const r1 = await MatterSources.runBatch(evs, 'calendar', seen) || { filed: [] };
        const r2 = await MatterSources.runBatch([task('t9', 'Fill in the new patient forms for Dr. Okafor', iso(inDays(7)))], 'commitment', seen) || { filed: [] };
        const folders = Matters.all();
        const dentist = folders.filter(m => /okafor|dent|clean/i.test(m.title));
        const surgery = folders.filter(m => /surg|mom/i.test(m.title));
        const lunch = folders.filter(m => /lunch|sam\b/i.test(m.title));
        const dup = Math.max(0, dentist.length - 1) + lunch.length;
        const missed = (surgery.length ? 0 : 1) + (dentist.length ? 0 : 1);
        const linked = dentist[0] && dentist[0].calendarEventId === 'e1';
        rows.push({ id: 'o2', name: 'own event and task join the folder mail opened; a new thing gets its own', calls: calls - before, dup, missed,
            note: `folders ${folders.length} (want 2) · dentist event linked: ${linked ? 'yes' : 'NO'} · forms task on the dentist folder: ${dentist[0] && (dentist[0].tasks || []).includes('t9') ? 'yes' : 'no'} · filed ${[...r1.filed, ...r2.filed].map(x => `${x.item} -> ${x.folder}`).join(' | ')}`,
            folders: folders.map(m => `${m.title} [${m.kind}, ${m.sources.map(x => x.kind).join('+')}]`) });
    }
    return rows;
}

async function run(sc) {
    blob = null; Matters._data = null; Matters._lastChange.clear();
    const before = calls;
    const none = [];
    for (const st of sc.steps) {
        if (st.own) await Matters.observe(st.own, { quiet: true });
        else { await Matters.file(st.msg, st.analysis); if (st.analysis.none) none.push(st.msg.messageId); }
    }
    const folders = Matters.all();
    const dup = Math.max(0, folders.length - sc.things);
    let missed = Math.max(0, sc.things - folders.length);
    const problem = folders.length === sc.things && sc.check ? sc.check(folders) : null;
    if (problem) missed++;
    const stats = (Matters._load().stats) || {};
    return { id: sc.id, name: sc.name, preview: !!sc.preview, want: sc.things, got: folders.length, dup, missed, calls: calls - before, secondLooks: stats.secondLooks || 0, found: stats.secondLookFound || 0, passed: stats.passed || 0,
        note: problem || '', folders: folders.map(m => `${m.title} [${m.kind}, ${m.state}, ${m.sources.length} src]`) };
}

(async () => {
    const t0 = Date.now();
    const rows = [];
    for (const sc of SCENARIOS) {
        if (ONLY && !ONLY.has(sc.id)) continue;
        if (VERBOSE) console.log(`\n${sc.id} ${sc.name}`);
        rows.push(await run(sc));
    }
    if (!ONLY || ONLY.has('t1')) rows.push(await tidyScenario());
    const chat = !ONLY || ONLY.has('c1') ? await chatScenario() : [];
    const own = !ONLY || ONLY.has('o1') ? await sourcesScenario() : [];

    console.log(`\nMatters eval — ${MODEL} on :${PORT}\n`);
    for (const r of rows) {
        const mark = r.dup || r.missed ? 'FAIL' : 'ok  ';
        console.log(`${mark} ${r.id.padEnd(4)} ${r.name}${r.preview ? ' (not counted)' : ''}`);
        if (r.want != null) console.log(`       folders ${r.got} (want ${r.want}) · calls ${r.calls} · second looks ${r.secondLooks} (found ${r.found}) · passed over ${r.passed}${r.note ? ` · ${r.note}` : ''}`);
        else console.log(`       pairs found ${r.found.length} · calls ${r.calls} · ${r.note}`);
        if ((r.dup || r.missed || VERBOSE) && r.folders) for (const f of r.folders) console.log(`         - ${f}`);
    }
    if (chat.length) {
        console.log('\n     c1   what the person says in a folder\'s chat');
        for (const c of chat) console.log(`${c.ok ? 'ok  ' : 'FAIL'}        "${c.say}" -> ${c.got}${c.when ? ` (${c.when})` : ''}`);
    }
    if (own.length) {
        console.log('\n     the person\'s own tasks and events as sources (flag off; not counted)');
        for (const r of own) {
            console.log(`${r.dup || r.missed ? 'FAIL' : 'ok  '} ${r.id.padEnd(4)} ${r.name}\n       calls ${r.calls} · ${r.note}`);
            if ((r.dup || r.missed || VERBOSE) && r.folders) for (const f of r.folders) console.log(`         - ${f}`);
        }
    }
    const gate = rows.filter(r => !r.preview);
    const dups = gate.reduce((n, r) => n + r.dup, 0), missed = gate.reduce((n, r) => n + r.missed, 0), chatBad = chat.filter(c => !c.ok).length;
    console.log(`\nDUPLICATES MADE: ${dups}   MAJORS MISSED: ${missed}   chat lines wrong: ${chatBad}/${chat.length}   model calls: ${calls}   ${Math.round((Date.now() - t0) / 1000)}s`);
    process.exit(dups || missed || chatBad ? 1 : 0);
})();
