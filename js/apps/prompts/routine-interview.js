/**
 * Routine Interview
 *
 * A routine the user arrived at by TALKING to the assistant, not by
 * filling in the form — the same shape as the goal and portfolio-strategy
 * interviews, and for the same reason: users generally do not know what a
 * workable routine needs to contain, or even what routines can do for
 * them. Asking "what do you want to automate?" gets a shrug; the agenda
 * below opens with what a routine IS, then walks the pieces one at a time.
 *
 * The agenda is fixed HERE, deterministically, and handed to the model one
 * topic at a time with the reason each topic matters
 * (`start_routine_interview` in agent-tools). A small local model can run
 * a competent intake off this; it cannot invent one.
 *
 * Unlike goals there is NO draft store: a routine is three or four answers
 * and one `create_routine` call at the end — and that call is the arming
 * consent (the confirmation dialog naming the trigger and whether it can
 * act), which must stay the single place a routine comes to life. An
 * interrupted interview leaves nothing armed, which is the correct
 * failure.
 */

const RoutineInterview = {

    /**
     * Order is deliberate: what it should do constrains the trigger, the
     * trigger constrains how to word the prompt, and the mode decides what
     * the user is consenting to — so it is read back right before creation.
     */
    INTERVIEW: [
        {
            id: 'purpose',
            required: true,
            question: 'What should nenva do for you on its own?',
            why: 'A routine is a standing instruction: nenva carries it out with what it already has. Naming a concrete thing ("tell me when the visa bulletin dates change", "watch my trademark mail") beats a vague wish ("keep me organized"). The answer also decides WHERE it belongs, and not everything belongs in a routine.',
            hint: 'Decide where it belongs before asking anything else, and say it in one line. Something the PERSON does at a time ("remind me to call the lawyer Friday at 3") is a commitment: make it with the commitment tools, not a routine. A morning overview of their day is what their Now page already is: say so and create nothing. About their mail or texts (a sender, a kind of letter) → a routine with watcher "mail": nenva reads every message already, so it needs no schedule. About their money (accounts, holdings, their plan, spending, bills) → watcher "money": the money coach follows it. Anything nothing watches (a web page, a price, a public list, the news) → a routine of its own.',
            examples: [
                'Tell me when the visa bulletin dates for my category change',
                'Tell me right away when the USPTO writes about my trademark',
                'Tell me when a sleeve of my Core Growth plan leaves its band',
                'Each weekday morning, the quantum computing news I have not seen'
            ]
        },
        {
            id: 'tells',
            required: true,
            question: 'Should it tell you every time, or only when something changes?',
            why: 'This is the difference between a watch and a delivery. A watch ("keep track of", "tell me when") stays quiet until what it watches changes, then says exactly what changed. A delivery (a roundup, a review) brings something each time, but only what is new since the last one.',
            hint: 'Usually clear from their words: "tell me when", "keep track", "watch" → "change"; "a roundup", "a summary", "a review every Friday" → "each". Confirm rather than ask when it is clear. Pass it as `tells`.',
            examples: ['Only when the dates move', 'Every morning, whatever is new']
        },
        {
            id: 'trigger',
            required: true,
            question: 'When should it run?',
            why: 'A time they name is kept exactly: it runs then, every time. With no time named, nenva picks its own pace (a watch on a public page: once a day is plenty).',
            hint: 'Skip for watcher "mail" (it is read as messages arrive). For watcher "money", give a time trigger ONLY when they named a time; otherwise leave it out and the coach follows it on its looks. For its own routine: a schedule (hourly, every 6h, daily, weekdays, weekly; daily/weekly want a time, propose one), an email trigger only for something that is NOT about their mail in general, or a file trigger (a folder path, optional pattern). Derive it from their words rather than listing the options back at them.',
            examples: ['Weekdays at 7:30 AM', 'Once a day is fine', 'When anything lands in ~/Downloads/receipts']
        },
        {
            id: 'mode',
            required: true,
            question: 'Should it tell you things, or take actions?',
            why: 'This is what the user is consenting to. Telling is read-only. Actions can change their data (file things, create tasks, send drafts), each step still permission-gated, and each run keeps its log on the routine\'s page.',
            hint: 'Default to telling (digest). Choose task ONLY when the ask needs something done, not something said. An instruction to a watcher only tells. Say plainly which one you are setting up.',
            examples: ['Just tell me', 'Actually file each invoice as a task']
        },
        {
            id: 'sources',
            required: false,
            question: 'Should it use the web, your own data, or both?',
            why: 'Grounded in nothing, it is the model\'s recall. web=true reaches outside (news, public pages, prices); useContext=true reads their own records (memory, projects, schedule).',
            hint: 'Usually derivable from the purpose: a public page or news needs web, a review of their own work needs context. Skip for an instruction to a watcher (it already reads what it watches) and for task mode when the goal implies it.',
            examples: ['Web for the bulletin', 'My context for the project review']
        },
        {
            id: 'review',
            required: true,
            question: 'Say it back in one sentence, then create it.',
            why: 'The person confirms with one tap, on one sentence. Their confirmation shows that sentence with the app\'s own reading of the schedule, so the time is never misstated.',
            hint: 'Write `saysBack`: what nenva will do and when it will tell them, as the end of a sentence that starts "I\'ll", addressed to them ("you", "your", never "my" or "me"), with nothing about how often (no "daily", "each morning", "each time it runs"): the app puts the schedule in front of it, e.g. "check the visa bulletin and tell you only when the EB-2 or EB-3 dates change". Then call create_routine ONCE with it, `tells`, and `watcher` when it has one. The prompt must be SELF-CONTAINED (every stated preference baked in) and, for email/file triggers, written about "the thing that triggered this run", never as a search. Do not also read back the fields; the confirmation is the read-back.'
        }
    ],

    /** Topic by id, for the tool handler. */
    topic(id) {
        return this.INTERVIEW.find(t => t.id === id) || null;
    }
};
