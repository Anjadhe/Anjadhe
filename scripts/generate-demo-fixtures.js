/*
 * Regenerate the realistic demo paperwork in scripts/demo-files/ (checked
 * into git; scripts/seed-demo-data.js copies it into the demo root).
 *
 *   npx electron scripts/generate-demo-fixtures.js
 *
 * Text documents (invoices, statements, manual, flyer) render HTML through
 * printToPDF, so they are REAL PDFs with a selectable text layer — the
 * agent's pdf.js path reads them. "Scanned" documents (utility bill,
 * receipt) are screenshotted first and the PDF embeds only the image, so
 * they exercise the macOS-Vision OCR fallback exactly like a real scan.
 *
 * Numbers here are load-bearing for the demos: INV-2031 $1,850.00 matches
 * the seeded remittance email; the utility bill's $482.19 due Aug 15 and
 * the receipt's $22.48 are cited in docs/DEMO.md. Keep them in sync.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'demo-files');

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1a1a1a;
         font-size: 11px; line-height: 1.45; padding: 48px 56px; }
  h1 { font-size: 20px; letter-spacing: .02em; }
  h2 { font-size: 13px; margin: 18px 0 6px; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .06em;
       color: #666; padding: 6px 8px; border-bottom: 1.5px solid #222; }
  td { padding: 6px 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #666; }
  .small { font-size: 9.5px; }
  .row { display: flex; justify-content: space-between; gap: 24px; }
  .totals td { border: none; padding: 3px 8px; }
  .totals .grand { font-weight: 700; font-size: 13px; border-top: 2px solid #222; }
`;

function invoiceHtml({ num, issued, due, billTo, lines, note, paid }) {
  const subtotal = lines.reduce((s, l) => s + l.qty * l.rate, 0);
  const fmt = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2 });
  return `<html><head><style>${BASE_CSS}</style></head><body>
    <div class="row">
      <div>
        <h1>Emily Carter Consulting</h1>
        <div class="muted small">Product strategy &amp; discovery<br>
        2404 Bluebonnet Ln, Austin, TX 78704<br>emily@carterconsulting.example · (512) 555-0184</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:22px; letter-spacing:.08em; color:#444;">INVOICE</div>
        <div class="small" style="margin-top:6px">
          <b>${num}</b><br>Issued: ${issued}<br>Due: <b>${due}</b> (Net 30)
        </div>
      </div>
    </div>
    <h2 style="margin-top:28px">Bill to</h2>
    <div>${billTo}</div>
    <div style="margin-top:22px"></div>
    <table>
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
      <tbody>
        ${lines.map(l => `<tr><td>${l.desc}</td><td class="num">${l.qty}</td><td class="num">${fmt(l.rate)}</td><td class="num">${fmt(l.qty * l.rate)}</td></tr>`).join('')}
      </tbody>
    </table>
    <div class="row" style="margin-top:14px">
      <div class="small muted" style="max-width:55%">${note || ''}</div>
      <table class="totals" style="width:240px">
        <tr><td>Subtotal</td><td class="num">${fmt(subtotal)}</td></tr>
        <tr><td>Tax</td><td class="num">$0.00</td></tr>
        <tr class="grand"><td class="grand">Amount due</td><td class="num grand">${fmt(subtotal)}</td></tr>
      </table>
    </div>
    <div class="small muted" style="margin-top:40px">
      Payment by ACH to First Ledger Bank, routing 111000614, account ending 3327, or by check to the address above.
      ${paid ? '' : 'A 1.5% monthly late fee applies to balances past due.'}
    </div>
  </body></html>`;
}

const DOCS = {
  'invoice-2031-meadow-books.pdf': invoiceHtml({
    num: 'INV-2031', issued: 'June 27, 2026', due: 'July 27, 2026',
    billTo: 'Meadow Books LLP<br>Attn: Accounts Payable<br>410 Congress Ave, Suite 300, Austin, TX 78701',
    lines: [
      { desc: 'Product discovery workshop (on-site, full day)', qty: 1, rate: 1400 },
      { desc: 'Workshop synthesis &amp; opportunity map', qty: 3, rate: 150 },
    ],
    note: 'Thank you! Workshop held June 24; synthesis delivered June 26.',
  }),
  'invoice-2032-cedar-labs.pdf': invoiceHtml({
    num: 'INV-2032', issued: 'July 30, 2026', due: 'August 29, 2026',
    billTo: 'Cedar Labs Inc<br>Attn: Maya Chen, VP Product<br>1801 E 6th St, Austin, TX 78702',
    lines: [
      { desc: 'Roadmap coaching session (remote, 90 min)', qty: 3, rate: 650 },
      { desc: 'Pre-read review &amp; written feedback', qty: 3, rate: 150 },
    ],
    note: 'Sessions July 8, 15, 22. Next block available in September.',
  }),
  'invoice-2033-north-pier.pdf': invoiceHtml({
    num: 'INV-2033', issued: 'July 30, 2026', due: 'September 12, 2026',
    billTo: 'North Pier Media<br>Attn: J. Alvarez<br>98 San Jacinto Blvd, Austin, TX 78701',
    lines: [
      { desc: 'PM interview training (two half-day cohorts)', qty: 1, rate: 900 },
      { desc: 'Interview rubric customization', qty: 1, rate: 75 },
    ],
    note: 'DRAFT — dates to be confirmed with the hiring team.',
  }),

  'bank-statement.pdf': `<html><head><style>${BASE_CSS}</style></head><body>
    <div class="row">
      <div><h1>First Ledger Bank</h1>
      <div class="muted small">PO Box 9410, Austin, TX 78766 · firstledger.example</div></div>
      <div style="text-align:right" class="small">
        <b>Statement of Account</b><br>July 1 – July 28, 2026<br>
        Emily Carter · Checking ····3327
      </div>
    </div>
    <h2 style="margin-top:26px">Account summary</h2>
    <table>
      <tr><td>Beginning balance (July 1)</td><td class="num">$3,912.40</td></tr>
      <tr><td>Deposits &amp; credits (4)</td><td class="num">$4,655.00</td></tr>
      <tr><td>Withdrawals &amp; debits (9)</td><td class="num">&minus;$3,745.74</td></tr>
      <tr><td><b>Ending balance (July 28)</b></td><td class="num"><b>$4,821.66</b></td></tr>
    </table>
    <h2 style="margin-top:22px">Transactions</h2>
    <table>
      <thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead>
      <tbody>
        <tr><td>Jul 1</td><td>FERNWOOD SOFTWARE PAYROLL</td><td class="num">$3,180.00</td><td class="num">$7,092.40</td></tr>
        <tr><td>Jul 2</td><td>AUSTIN POWER &amp; LIGHT AUTOPAY</td><td class="num">&minus;$231.87</td><td class="num">$6,860.53</td></tr>
        <tr><td>Jul 5</td><td>WHOLESOME MARKET #204</td><td class="num">&minus;$164.19</td><td class="num">$6,696.34</td></tr>
        <tr><td>Jul 7</td><td>MORTGAGE PAYMENT — LONGHORN HOME LOANS</td><td class="num">&minus;$2,140.00</td><td class="num">$4,556.34</td></tr>
        <tr><td>Jul 9</td><td>CEDAR LABS INC ACH CREDIT</td><td class="num">$1,300.00</td><td class="num">$5,856.34</td></tr>
        <tr><td>Jul 12</td><td>STREAMNEST SUBSCRIPTION</td><td class="num">&minus;$15.99</td><td class="num">$5,840.35</td></tr>
        <tr><td>Jul 14</td><td>CEDAR PARK HARDWARE</td><td class="num">&minus;$22.48</td><td class="num">$5,817.87</td></tr>
        <tr><td>Jul 15</td><td>TRANSFER TO SAVINGS ····8841</td><td class="num">&minus;$500.00</td><td class="num">$5,317.87</td></tr>
        <tr><td>Jul 18</td><td>WHOLESOME MARKET #204</td><td class="num">&minus;$142.66</td><td class="num">$5,175.21</td></tr>
        <tr><td>Jul 21</td><td>CHECK 1088 — OAK HOLLOW ELEMENTARY PTA</td><td class="num">&minus;$45.00</td><td class="num">$5,130.21</td></tr>
        <tr><td>Jul 22</td><td>INTEREST CREDIT</td><td class="num">$0.85</td><td class="num">$5,131.06</td></tr>
        <tr><td>Jul 24</td><td>BRIGHT SMILE DENTAL</td><td class="num">&minus;$95.00</td><td class="num">$5,036.06</td></tr>
        <tr><td>Jul 26</td><td>HEB FUEL #114</td><td class="num">&minus;$48.55</td><td class="num">$4,987.51</td></tr>
        <tr><td>Jul 27</td><td>PIANO LESSONS — E. SORENSEN MUSIC</td><td class="num">&minus;$165.85</td><td class="num">$4,821.66</td></tr>
        <tr><td>Jul 28</td><td>ZELLE FROM MARK CARTER</td><td class="num">$174.15</td><td class="num">$4,995.81*</td></tr>
      </tbody>
    </table>
    <div class="small muted" style="margin-top:10px">* Posted after the statement close; reflected on your August statement.</div>
    <div class="small muted" style="margin-top:28px">Member FDIC. Questions? Call (800) 555-0139 or visit any branch.</div>
  </body></html>`,

  'brokerage-statement-june.pdf': `<html><head><style>${BASE_CSS}</style></head><body>
    <div class="row">
      <div><h1>Northbridge Brokerage</h1>
      <div class="muted small">Monthly statement · June 1 – June 30, 2026</div></div>
      <div style="text-align:right" class="small">Emily Carter · Individual ····7719</div>
    </div>
    <h2 style="margin-top:24px">Account value</h2>
    <table>
      <tr><td>Opening value (June 1)</td><td class="num">$47,210.11</td></tr>
      <tr><td>Change in investment value</td><td class="num">$709.51</td></tr>
      <tr><td>Dividends &amp; interest</td><td class="num">$84.10</td></tr>
      <tr><td><b>Closing value (June 30)</b></td><td class="num"><b>$48,003.72</b></td></tr>
    </table>
    <h2 style="margin-top:22px">Holdings</h2>
    <table>
      <thead><tr><th>Symbol</th><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Value</th></tr></thead>
      <tbody>
        <tr><td>VTI</td><td>Vanguard Total Stock Market ETF</td><td class="num">88</td><td class="num">$296.40</td><td class="num">$26,083.20</td></tr>
        <tr><td>AAPL</td><td>Apple Inc</td><td class="num">45</td><td class="num">$228.10</td><td class="num">$10,264.50</td></tr>
        <tr><td>MSFT</td><td>Microsoft Corp</td><td class="num">18</td><td class="num">$472.33</td><td class="num">$8,501.94</td></tr>
        <tr><td>—</td><td>Cash &amp; sweep</td><td class="num">—</td><td class="num">—</td><td class="num">$3,154.08</td></tr>
      </tbody>
    </table>
    <div class="small muted" style="margin-top:28px">Securities are not FDIC insured and may lose value. Dividend detail on page 2 of the mailed statement.</div>
  </body></html>`,

  'manual-dishwasher-DW450.pdf': `<html><head><style>${BASE_CSS}</style></head><body>
    <h1>QuietWave DW450</h1>
    <div class="muted" style="margin-bottom:18px">Built-in dishwasher · Quick reference &amp; warranty</div>
    <h2>Warranty</h2>
    <p>Your DW450 is covered for <b>24 months, parts and labor</b>, from the date of purchase.
    Keep your receipt; service requires proof of purchase. Racks and filters carry a 5-year parts warranty.</p>
    <h2 style="margin-top:16px">Error codes</h2>
    <table>
      <thead><tr><th>Code</th><th>Meaning</th><th>What to try</th></tr></thead>
      <tbody>
        <tr><td>E1</td><td>Door not latched</td><td>Close the door firmly until it clicks.</td></tr>
        <tr><td>E3</td><td>Drain blocked</td><td>Clean the filter; check the drain hose for kinks.</td></tr>
        <tr><td>E4</td><td>Water supply</td><td>Open the inlet valve fully; check the supply hose.</td></tr>
        <tr><td>E7</td><td>Heater fault</td><td>Requires service — call the number below.</td></tr>
      </tbody>
    </table>
    <h2 style="margin-top:16px">Monthly care</h2>
    <p>Twist the filter counter-clockwise to remove; rinse under warm water. Wipe the door gasket. Run a cleaning cycle with the machine empty.</p>
    <div class="small muted" style="margin-top:30px">QuietWave Appliance Co · Support (877) 555-0122 · Model DW450 · This page: quick reference. Full manual at quietwave.example/dw450.</div>
  </body></html>`,

  'fall-soccer-schedule.pdf': `<html><head><style>${BASE_CSS}
    .hero { background:#f0f4ec; border:1.5px solid #33691e; border-radius:10px; padding:16px 20px; margin-bottom:18px; }
  </style></head><body>
    <div class="hero">
      <h1>Oak Hollow Stars ⚽ Fall Season</h1>
      <div class="muted">3rd grade recreational league · Coach Ramirez · Zilker Fields</div>
    </div>
    <table>
      <thead><tr><th>Date</th><th>Kickoff</th><th>Opponent</th><th>Field</th><th>Snack duty</th></tr></thead>
      <tbody>
        <tr><td>Sat, Aug 8, 2026</td><td>9:00 AM</td><td>Barton Bears</td><td>Field 2</td><td>Nguyen family</td></tr>
        <tr><td>Sat, Aug 15, 2026</td><td>10:30 AM</td><td>Mueller Comets</td><td>Field 5</td><td><b>Carter family</b></td></tr>
        <tr><td>Sat, Aug 22, 2026</td><td>9:00 AM</td><td>Zilker Owls</td><td>Field 1</td><td>Brooks family</td></tr>
        <tr><td>Sat, Aug 29, 2026</td><td>11:00 AM</td><td>Travis Thunder</td><td>Field 3</td><td>Okafor family</td></tr>
      </tbody>
    </table>
    <h2 style="margin-top:18px">Every week</h2>
    <p>Shin guards and cleats required · bring a filled water bottle · arrive 20 minutes before kickoff for warm-up.
    Snack duty = orange slices at halftime and a small snack after the game (about 12 kids).</p>
    <div class="small muted" style="margin-top:26px">Rainout line: (512) 555-0171 · updates on the league page the night before.</div>
  </body></html>`,

  // ── scanned (image-only) documents — these must OCR, never text-extract ──
  '_scan_utility-bill.html': `<html><head><style>${BASE_CSS}
    body { background:#e8e6e1; padding: 30px; }
    .page { background:#fdfdfa; width: 660px; margin: 0 auto; padding: 44px 50px;
            transform: rotate(-0.7deg); box-shadow: 0 3px 14px rgba(0,0,0,.25); }
  </style></head><body><div class="page">
    <div class="row">
      <div><h1>Austin Power &amp; Light</h1>
      <div class="muted small">PO Box 220, Austin, TX 78767</div></div>
      <div class="small" style="text-align:right"><b>Service statement</b><br>Billing period: Jun 28 – Jul 28, 2026<br>Account 8823-4471</div>
    </div>
    <h2 style="margin-top:22px">Service address</h2>
    <div>Emily Carter · 2404 Bluebonnet Ln, Austin, TX 78704</div>
    <h2 style="margin-top:18px">Summary of charges</h2>
    <table>
      <tr><td>Electric service (1,286 kWh @ $0.1289)</td><td class="num">$165.77</td></tr>
      <tr><td>Delivery &amp; base charges</td><td class="num">$61.20</td></tr>
      <tr><td>Water &amp; wastewater</td><td class="num">$188.44</td></tr>
      <tr><td>Trash &amp; recycling</td><td class="num">$52.30</td></tr>
      <tr><td>Sales tax</td><td class="num">$14.48</td></tr>
      <tr><td><b>Statement total</b></td><td class="num"><b>$482.19</b></td></tr>
    </table>
    <p style="margin-top:16px"><b>Amount due by August 15, 2026: $482.19</b></p>
    <div class="small muted" style="margin-top:8px">Usage was 12% higher than July last year — mostly cooling. Enroll in autopay at austinpl.example to avoid late fees.</div>
  </div></body></html>`,

  '_scan_receipt-hardware.html': `<html><head><style>
    * { box-sizing:border-box; margin:0 }
    body { background:#e8e6e1; padding: 26px; font-family: 'Courier New', monospace; }
    .slip { background:#fffef8; width: 300px; margin: 0 auto; padding: 22px 20px;
            transform: rotate(1.1deg); box-shadow: 0 3px 12px rgba(0,0,0,.3);
            font-size: 13px; line-height: 1.55; }
    .c { text-align:center } .r { text-align:right } .line { display:flex; justify-content:space-between }
    hr { border:none; border-top:1px dashed #999; margin:8px 0 }
  </style></head><body><div class="slip">
    <div class="c"><b>CEDAR PARK HARDWARE</b><br>601 W Whitestone Blvd<br>Cedar Park, TX 78613<br>(512) 555-0163</div>
    <hr>
    <div>JUL 14 2026  10:22 AM<br>REG 2  CLERK 07  #48113</div>
    <hr>
    <div class="line"><span>SUPPLY LINE S/S 3/4"</span><span>18.99</span></div>
    <div class="line"><span>TEFLON TAPE 1/2"</span><span>3.49</span></div>
    <hr>
    <div class="line"><span>SUBTOTAL</span><span>22.48</span></div>
    <div class="line"><span>TAX</span><span>0.00</span></div>
    <div class="line"><b>TOTAL</b><b>22.48</b></div>
    <div class="line"><span>VISA ····4482</span><span>22.48</span></div>
    <hr>
    <div class="c">RETURNS: 90 DAYS WITH RECEIPT<br>THANK YOU FOR SHOPPING LOCAL</div>
  </div></body></html>`,
};

// data: URLs fail intermittently (ERR_FAILED) at these sizes — load from a
// temp file instead.
const os = require('os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-fixtures-'));
let tmpN = 0;
async function loadHtml(win, html) {
  const p = path.join(TMP, `page-${tmpN++}.html`);
  fs.writeFileSync(p, html);
  await win.loadFile(p);
}

// ONE reused window: creating/destroying a window per document made every
// load after the first fail with ERR_FAILED.
let theWin = null;
function getWin() {
  if (!theWin || theWin.isDestroyed()) {
    theWin = new BrowserWindow({ show: false, width: 900, height: 1500, webPreferences: { offscreen: true, sandbox: true } });
  }
  return theWin;
}

async function renderPdf(file, html) {
  const win = getWin();
  await loadHtml(win, html);
  await new Promise((r) => setTimeout(r, 250));
  const pdf = await win.webContents.printToPDF({ pageSize: 'Letter', printBackground: true });
  fs.writeFileSync(path.join(OUT, file), pdf);
  console.log('  pdf   ' + file);
}

async function renderScanPdf(file, html, width) {
  const win = getWin();
  win.setSize(width, 1500);
  await loadHtml(win, html);
  await new Promise((r) => setTimeout(r, 400));
  // Crop to the actual content so the "scan" fits one Letter page instead
  // of spilling a blank second page.
  const contentH = await win.webContents.executeJavaScript('document.body.scrollHeight');
  const shot = await win.webContents.capturePage({ x: 0, y: 0, width, height: Math.min(1500, Math.ceil(contentH)) });
  const png = shot.toPNG().toString('base64');
  win.setSize(900, 1500);
  // A page whose only content is the screenshot: the printed PDF carries no
  // text layer at all, exactly like a real scan.
  await renderPdf(file, `<html><body style="margin:0"><img style="width:100%" src="data:image/png;base64,${png}"></body></html>`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  try {
    for (const [file, html] of Object.entries(DOCS)) {
      if (file.startsWith('_scan_')) continue;
      await renderPdf(file, html);
    }
    await renderScanPdf('scanned-utility-bill.pdf', DOCS['_scan_utility-bill.html'], 760);
    await renderScanPdf('scanned-receipt-hardware.pdf', DOCS['_scan_receipt-hardware.html'], 360);
    console.log('done → ' + OUT);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  app.quit();
});
