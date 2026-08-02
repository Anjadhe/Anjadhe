# AI Assistant: sample use cases

What the assistant can actually do for a real person, written as the person
would ask for it. Every case below runs on the shipped app (C0–C8, see
`docs/COWORK_AGENT.md`) and almost all have ready-made material in the demo
seed (`scripts/seed-demo-data.js`, persona Emily Carter — see
`docs/DEMO.md` §3a for the demo walkthrough of each).

The capability spine these lean on:

| Capability | What it means |
|---|---|
| Documents as input | Reads PDFs (page by page), scanned documents (local OCR), spreadsheets (xlsx/csv as totable text), docx, images — the *contents*, never just the filename |
| Files & apps | Lists, reads, writes, organizes files under permission scopes; writes notes, tasks, calendar items, journal entries in-app |
| Email & calendar | Reads and acts on connected Gmail/Calendar; sending always asks (standing permission defaults to known contacts only) |
| Web | Search, page reading (PDF links included), and a real browser (click, fill, log in) via the one-click Browser connection |
| Tasks | Multi-step jobs: plan → approve → run → verify (with computed checks) → report |
| Recipes | A task that verified clean can be saved and replayed — deterministic steps, model fills the parameters |
| Automations | Time, new-email, and new-file triggers start tasks unattended; asks pause + notify; everything reviewable on the Automations page |
| Bounds | Standing permissions can carry daily budgets, expiry, and exclusions; exhaustion asks and says why |
| Ledger & undo | Every write is recorded; record pills under answers; "Undo this turn" / "Undo changes" with honest limits |
| Connections | One-click MCP servers (Browser, DeepWiki, Context7, GitHub) — hosted ones need no install |

---

## Working with documents

**1. Total the invoices** — *independent professional, contractor*
> "Total the invoices in my Invoices folder and write me a note with the
> breakdown per client."

Reads each invoice PDF, does the arithmetic, writes the note. The
note appears as a pill under the answer; the write is in the ledger. Run it
as a task and a clean verify offers **Save as recipe** — next month is
"run the invoice roundup for August".
*Demo: `Anjadhe Demo/Invoices/` (three invoices; the remittance email marks
INV-2031 paid, so "which are still unpaid?" has a right answer).*

**2. Answer from a statement** — *anyone*
> "What's the closing balance in my bank statement?"

Opens the PDF and answers from its contents.
*Demo: `Anjadhe Demo/Statements/bank-statement.pdf`.*

**3. Read a scanned document** — *anyone*
> "What does this scanned bill say the total and due date are?"

Image-only PDFs and photos go through the local macOS OCR fallback —
nothing leaves the machine.
*Demo: `Anjadhe Demo/Scans/scanned-utility-bill.pdf` ($482.19, due Aug 15).*

**4. Job-sheet totals for the accountant** — *tradesperson, shift worker*
> "Read my job-sheet spreadsheet and total the miles and materials per site."

Spreadsheets arrive as text the model can total, per sheet.
*Demo: `Anjadhe Demo/JobSheets/jobsheet-week.xlsx`.*

**5. School paperwork into the schedule** — *parent*
> "Put the soccer games and the field-trip deadlines on my schedule, and
> tell me what Owen needs to bring."

Dates come off the schedule file and the school email; each created item is
a pill, each is undoable.
*Demo: `Anjadhe Demo/School/fall-soccer-schedule.pdf` + the Oak Hollow
field-trip email.*

**6. Warranty and return windows** — *homemaker, anyone*
> "Read this receipt and the appliance manual, and note the return deadline
> and the warranty period."

*Demo: `Anjadhe Demo/ToFile/scanned-receipt-hardware.pdf` (image-only — OCR) +
`manual-dishwasher-DW450.pdf`.*

## Organizing (and taking it back)

**7. File the pile** — *homemaker, anyone*
> "Organize my ToFile folder: statements into Statements, receipts into
> Receipts, manuals into Manuals."

It reads contents to decide (not filenames), moves the files, and the task
report shows what changed. The wrong call is one **Undo changes** away;
deletes only ever go to the macOS Trash.
*Demo: `Anjadhe Demo/ToFile/` — organize it, check the result, undo it.*

## Email-driven work

**8. Invoice chasing** — *freelancer*
> "When a remittance email arrives, mark the matching invoice task done."
> (armed as an automation) — plus one-off asks like "which clients haven't
> paid yet?"

Sending follow-ups can ride a standing send_email permission that is
**known-contacts-only by default** and can carry a daily budget — a brand
new recipient always asks first.
*Demo: the Meadow Books remittance email.*

**9. Weekly family digest** — *parent*
> Automation, weekly: "Read the next week's schedule and any unread school
> email, and write the 'Week ahead' note: who needs to be where, what's
> due, what to pack."

*Demo: armed as the "Week ahead" automation — press Run now.*

## Unattended automations

**10. Tailored resume from a LinkedIn job alert** — *job seeker*
> Armed: "When an email arrives from linkedin.com, read the job description
> in it and my baseline resume, and write a tailored resume note —
> reorder and reword my real experience to match the posting. Never invent
> experience."

The alert lands while you're away; the task runs headless; if a step needs
permission it pauses and sends a system notification. The result and what
it changed are on the Automations page.
*Demo: armed; the Lakeline Robotics alert + `Resumes/baseline-resume.docx`
are the material. Run now to watch it live.*

**11. Amazon price watch** — *anyone*
> Armed, daily 9am: "Check the price of the Sony WH-1000XM5 on amazon.com,
> append it to my Price Watch note, and if it's at or below $299 create a
> 'buy it' task."

Uses the real Browser connection when added (Settings › Tool Servers › one
click), otherwise search + page reading. The note accumulates a dated price
history.
*Demo: armed; the "Price Watch: Sony WH-1000XM5" note holds the history.*

**12. The drop folder** — *contractor, anyone*
> Armed: "When a file lands in Drop/, read it and create a task with the
> vendor, amount, and any due date."

Saving the file *is* the filing.
*Demo: armed on `Anjadhe Demo/Drop/` — drop any quote or invoice in.*

## Research and reach

**13. Research clerk with real sources** — *any professional*
> "Look up how library X handles Y and save me a note with links." ·
> "Check my open GitHub issues and draft a status note." · "Log into the
> vendor portal and download this month's statement."

DeepWiki/Context7 (hosted, no install) for technical lookups, GitHub with a
pasted token, the Browser connection for sites that need a real session.
Every action still passes the permission gate, and web content is always
treated as data, never as instructions.

---

## The trust model, in one paragraph

Every write is permission-gated (C1) and recorded in a ledger (C8.4); the
pills under an answer and the task report are views of that ledger, and
"Undo" restores what the ledger holds — while saying plainly what cannot be
taken back (sent email, calendar, other apps). Unattended runs exist only
because the user armed them (C8.5), pause and notify on any ask, and
standing permissions can be bounded — N per day, an expiry, known contacts
only — with exhaustion surfacing as a named ask, never a silent downgrade
(C8.6). The Automations page shows what's armed, what's waiting, what ran,
and what it changed, with one-tap revoke.

## Honest limits

- Mac app; automations run while Anjadhe is open on that Mac.
- Email/calendar cases need a connected Google account (or the seeded demo
  inbox).
- Browser-based cases need the one-click Browser connection (and Node.js —
  the app says so at Add time if it's missing).
- Undo covers ledger-backed changes; external actions say they can't be
  undone from here.
- The design floor is a local ~12B model; the eval suite
  (`tests/agent-evals/`) is how a new model is judged against exactly these
  kinds of tasks.

## Running the demos

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/seed-demo-data.js ~/AnjadheDemo --force
ANJADHE_DATA_ROOT=~/AnjadheDemo npm start
```

The paperwork is in `~/AnjadheDemo/Anjadhe Demo/`; approve the folder when
the assistant first asks (that ask is itself the C1 demo), or pre-scope
with `ANJADHE_APPS_DIR="$HOME/AnjadheDemo/Anjadhe Demo"`. The four armed
automations demo best via **Run now** on the Automations page.
