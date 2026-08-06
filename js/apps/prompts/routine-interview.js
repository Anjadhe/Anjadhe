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
            question: 'What should Anjadhe do for you on its own?',
            why: 'A routine is the app working while you are away — the answer here becomes the routine\'s job. Naming a concrete thing ("watch for invoices", "brief me each morning") beats a vague wish ("keep me organized").',
            examples: [
                'Every weekday morning, a digest of my portfolio against the news',
                'Whenever an invoice email arrives, pull out the amount and due date',
                'Weekly on Sunday evening, review my goals and what moved',
                'When a file lands in my Scans folder, summarize what it is'
            ]
        },
        {
            id: 'trigger',
            required: true,
            question: 'When should it run?',
            why: 'The trigger decides what each run is ABOUT. A schedule runs on the clock; an email or file trigger fires once per matching thing, and that run is about that one thing.',
            hint: 'Three kinds: a schedule (hourly, every 6h, daily, weekdays, weekly — daily/weekly want a time; propose one). An email trigger (from / subject / contains — prefer "contains" when they describe the content, e.g. "an email with an invoice in it"). A file trigger (a folder path, optional pattern). Derive it from their words rather than listing the options back at them.',
            examples: ['Weekdays at 7:30 AM', 'Whenever an email from my landlord arrives', 'When anything lands in ~/Downloads/receipts']
        },
        {
            id: 'mode',
            required: true,
            question: 'Should it write you an answer, or take actions?',
            why: 'This is what the user is consenting to. An answer (digest) is read-only and posts to the Home feed. Actions can change their data — file things, create tasks, send drafts — each step still permission-gated, and each run keeps its log on the routine\'s page instead of the feed.',
            hint: 'Default to digest. Choose task ONLY when the ask needs something done, not something written. Say plainly which one you are setting up.',
            examples: ['Just write me the summary', 'Actually file each invoice as a task']
        },
        {
            id: 'sources',
            required: false,
            question: 'Should it use the web, your own data, or both?',
            why: 'A digest grounded in nothing is the model\'s recall. web=true reaches outside (news, jobs, prices); useContext=true reads their own records (portfolio, schedule, goals).',
            hint: 'Usually derivable from the purpose — a news digest needs web, a goal review needs context. Confirm rather than ask open-ended. Skip entirely for task mode when the goal implies it.',
            examples: ['Web for headlines', 'My context for the goal review', 'Both for the portfolio-vs-news briefing']
        },
        {
            id: 'review',
            required: true,
            question: 'Read the routine back, then create it.',
            why: 'The user approves the arming dialog next — what you read back is what they are agreeing to, so it must name the trigger, the mode, and the prompt in one breath.',
            hint: 'Read back: title, when it runs, answer-vs-actions, sources, and the prompt text. Then call create_routine ONCE. The prompt must be SELF-CONTAINED (every stated preference baked in) and, for email/file triggers, written about "the thing that triggered this run" — never as a search. After creating, say where results land: the Home feed for digests, the routine\'s Run history for action runs.'
        }
    ],

    /** Topic by id, for the tool handler. */
    topic(id) {
        return this.INTERVIEW.find(t => t.id === id) || null;
    }
};
