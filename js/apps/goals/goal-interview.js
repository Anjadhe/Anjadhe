/**
 * Goal Interview
 *
 * A goal the user arrived at by TALKING to the assistant, not by filling in
 * a form — the same shape as the Portfolio Strategy interview, because the
 * problem is the same: users generally do not know what a workable goal
 * needs to contain. Asking "what's your goal?" gets a wish ("get fit");
 * the agenda below is what turns it into an outcome with a finish line, a
 * date, and a task timeline on the calendar.
 *
 * The agenda is fixed HERE, deterministically, and the assistant is handed
 * it one topic at a time with the reason each topic matters. A small local
 * model can run a competent intake off this; it cannot invent one.
 *
 * save(patch) merges field by field so the interview persists as it goes —
 * an interrupted conversation leaves a usable draft (status 'draft'), and
 * missingTopics() is what flips it to a real goal when the required topics
 * are covered. Tasks land as ordinary schedule items linked to the goal,
 * exactly the recipe GoalBreakdown and TaskListUI's "+ New Task" use.
 */

const GoalInterview = {

    // Review routines are linked BY TITLE (see ReviewRoutines) — renaming a
    // goal orphans its routine, and the page simply offers to start again.
    GOAL_REVIEW_PREFIX: 'Goal Review: ',

    /**
     * The interview agenda. Order is deliberate: the outcome and its finish
     * line constrain the date, and the date is what the task timeline hangs
     * from — asking for steps before knowing "done" produces busywork.
     * `field` topics live on the goal record; the steps topic is satisfied
     * by linked tasks existing (`check`), not by a field.
     */
    INTERVIEW: [
        {
            id: 'outcome',
            field: 'title',
            required: true,
            question: 'What do you want to accomplish?',
            why: 'A goal is something you can finish. Naming the outcome — not the activity — is what separates a goal from a wish.',
            examples: ['Run a 10K in under an hour', 'Ship the v2 release', 'Save $15,000 for the house fund', 'Read 12 books this year']
        },
        {
            id: 'done',
            field: 'description',
            required: true,
            question: 'What does done look like, concretely?',
            why: 'If you cannot tell the day it is finished, you will never feel finished. A measurable finish line is what future reviews check against.',
            examples: ['Crossed the finish line under 60:00', 'Feature live for all users, no P1 bugs for a week', 'Account balance shows $15,000']
        },
        {
            id: 'why',
            field: 'why',
            required: false,
            question: 'Why does this matter to you right now?',
            why: 'The why is what keeps a goal alive in week six. It is also what a review quotes back when progress stalls.',
            examples: ['Doctor said to get my heart rate up', 'This unlocks the next role', 'We promised the kids']
        },
        {
            id: 'deadline',
            field: 'targetDate',
            required: true,
            question: 'When should this be done by?',
            why: 'A date turns a direction into a commitment, and it is what the task timeline hangs from. A rough date beats no date.',
            hint: 'Resolve their answer to YYYY-MM-DD yourself ("end of October" means the date, not the phrase). Push back gently if the date and the outcome are obviously mismatched.',
            examples: ['In 3 months', 'By the end of the quarter', 'October 18']
        },
        {
            id: 'group',
            field: 'group',
            required: false,
            question: 'Which part of your life does this belong to?',
            why: 'Goals are shown grouped — Work, Health, Family — so related outcomes sit together. Reuse an existing group when one fits.',
            hint: 'Propose the best match from context.groups rather than asking open-ended; a new name is fine; blank is allowed.',
            examples: ['Work', 'Health', 'Family', 'Finance', 'Learning']
        },
        {
            id: 'steps',
            required: true,
            check: (goal) => LinkManager.getTasksForGoal(goal.id).length > 0,
            question: 'What are the first concrete steps, and when does each happen?',
            why: 'A goal only moves when it is on the calendar. Three to six tasks with dates spread toward the target date turn the plan into a timeline.',
            hint: 'PROPOSE the breakdown yourself from the outcome and target date — 3-6 tasks, one action each starting with a verb, dates spread realistically toward the target date (never all the same day). Let the user edit the list, then save it via save_goal tasks[].',
            examples: ['Sign up for the race — this week', 'Run Mon/Wed/Sat — repeating', 'Draft the spec — by Friday']
        },
        {
            id: 'obstacles',
            field: 'obstacles',
            required: false,
            question: 'What is most likely to get in the way?',
            why: 'Naming the obstacle now is cheap; discovering it in week three is not. Reviews will watch for it.',
            examples: ['Travel weeks break the routine', 'Depends on another team', 'I lose steam after the novelty fades']
        },
        {
            id: 'review',
            required: false,
            question: 'Want a weekly AI review of this goal?',
            why: 'A goal nobody looks at quietly stops being a goal. The review reads the linked tasks each week and posts an honest read to your Home feed.',
            hint: 'If yes, call save_goal with startWeeklyReview: true — never create the routine any other way.',
            examples: ['Yes, weekly', 'No, I will check it myself']
        }
    ],

    /**
     * Which required topics a goal still has nothing for. Drives the
     * interview (the assistant asks the FIRST missing topic, so the flow is
     * deterministic and resumable across conversations) and the draft/real
     * status flip in save().
     */
    missingTopics(goal) {
        if (!goal) return this.INTERVIEW.filter(t => t.required).map(t => t.id);
        return this.INTERVIEW.filter(topic => {
            if (!topic.required) return false;
            if (topic.check) return !topic.check(goal);
            const value = goal[topic.field];
            return !value || !String(value).trim();
        }).map(t => t.id);
    },

    /** The agenda entry for a topic id. */
    topic(id) {
        return this.INTERVIEW.find(t => t.id === id) || null;
    },

    /** Case-insensitive title match, then id. Used by the agent tools. */
    find(titleOrId) {
        if (!titleOrId) return null;
        const needle = String(titleOrId).trim().toLowerCase();
        GoalsApp.loadGoals();
        const list = GoalsApp.goals;
        return list.find(g => g.id === titleOrId)
            || list.find(g => (g.title || '').toLowerCase() === needle)
            || list.find(g => (g.title || '').toLowerCase().includes(needle))
            || null;
    },

    /**
     * Create or update a goal, merging field by field.
     *
     * Merge (not replace) is what lets the interview save as it goes: only
     * keys actually present in `patch` are touched. Interview-created goals
     * start as 'draft'; when a draft's required topics are all covered the
     * status flips to 'not-started' — a status the user set by hand is
     * never overwritten by the flip.
     */
    save(patch = {}) {
        GoalsApp.loadGoals();   // never trust in-memory state across apps
        const goals = GoalsApp.goals;
        const now = new Date().toISOString();

        let goal = patch.id ? goals.find(g => g.id === patch.id) : null;
        if (!goal && patch.title) {
            const needle = patch.title.trim().toLowerCase();
            goal = goals.find(g => (g.title || '').toLowerCase() === needle);
        }

        const isNew = !goal;
        if (isNew) {
            goal = {
                id: UIUtils.generateId(),
                title: patch.title || 'Untitled goal',
                description: '',
                why: '',
                obstacles: '',
                group: '',
                targetDate: null,
                status: 'draft',
                createdAt: now,
                history: []
            };
            goals.unshift(goal);
        }

        const changed = [];
        let renamedFrom = null;
        if (patch.new_title !== undefined && String(patch.new_title).trim()
            && patch.new_title !== goal.title) {
            renamedFrom = goal.title;
            goal.title = String(patch.new_title).trim();
            changed.push('title');
        }
        for (const key of ['description', 'why', 'obstacles', 'group']) {
            if (patch[key] !== undefined && patch[key] !== goal[key]) {
                goal[key] = String(patch[key]).trim();
                changed.push(key);
            }
        }
        if (patch.targetDate !== undefined) {
            const date = /^\d{4}-\d{2}-\d{2}$/.test(patch.targetDate || '') ? patch.targetDate : null;
            if (date !== goal.targetDate) { goal.targetDate = date; changed.push('targetDate'); }
        }
        if (patch.status !== undefined && GoalsApp.STATUSES.includes(patch.status)
            && patch.status !== goal.status) {
            goal.status = patch.status;
            changed.push('status');
        }

        const tasksAdded = this._addTasks(goal, patch.tasks);
        if (tasksAdded) changed.push('tasks');

        // The draft → real flip, computed AFTER tasks land (the steps topic
        // is satisfied by linked tasks). Only ever moves a draft forward.
        if (goal.status === 'draft' && this.missingTopics(goal).length === 0) {
            goal.status = 'not-started';
        }

        if (patch.startWeeklyReview && goal.title) {
            this.startWeeklyReview(goal.title);
        }

        if (changed.length) {
            goal.history = goal.history || [];
            goal.history.unshift({
                at: now,
                summary: patch.changeNote || (isNew ? 'Created' : `Updated ${changed.join(', ')}`)
            });
            goal.history = goal.history.slice(0, 20);
        }
        goal.modifiedAt = now;
        GoalsApp.saveGoals();

        // A renamed goal carries its review routine (and any routine quoting
        // the old title) along — see ReviewRoutines.syncRename.
        const routines = renamedFrom
            ? ReviewRoutines.syncRename(this.GOAL_REVIEW_PREFIX, renamedFrom, goal.title)
            : { updated: [], mentions: [] };
        return { goal, tasksAdded, routines };
    },

    /**
     * Materialize interview tasks as schedule items linked to the goal —
     * GoalBreakdown's exact recipe, with its floor-model defenses: dedup
     * against the goal's existing task titles, dates validated and never
     * in the past, and if every proposed date is the same day the dates
     * are dropped entirely (a "schedule" that says nothing).
     */
    _addTasks(goal, tasks) {
        if (!Array.isArray(tasks) || tasks.length === 0) return 0;
        const today = ScheduleApp.getLocalToday();
        const seen = new Set(LinkManager.getTasksForGoal(goal.id)
            .map(t => String(t.title || '').toLowerCase()));

        const clean = [];
        for (const t of tasks) {
            const title = typeof t?.title === 'string' ? t.title.trim().slice(0, 140) : '';
            if (!title || seen.has(title.toLowerCase())) continue;
            seen.add(title.toLowerCase());
            const date = (typeof t?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date)
                && !isNaN(new Date(t.date + 'T00:00:00')) && t.date >= today) ? t.date : null;
            const repeat = ['daily', 'weekdays', 'weekly'].includes(t?.repeat) ? t.repeat : null;
            clean.push({ title, date, repeat });
        }
        const dated = clean.filter(t => t.date && !t.repeat);
        if (dated.length > 1 && new Set(dated.map(t => t.date)).size === 1) {
            for (const t of dated) t.date = null;
        }

        let added = 0;
        for (const s of clean) {
            const newId = ScheduleApp.createTask(s.title);
            if (!newId) continue;
            const item = ScheduleApp.scheduleItems.find(i => i.id === newId);
            if (item) {
                // Plan steps stay undated unless a date was proposed —
                // createTask defaults to today, which floods the front door.
                item.scheduledDate = s.date || (s.repeat ? today : null);
                if (s.repeat) {
                    item.repeat = s.repeat;
                    if (s.repeat === 'weekly') {
                        item.dayOfWeek = new Date((s.date || today) + 'T12:00:00').getDay();
                    }
                }
                item.modifiedAt = new Date().toISOString();
            }
            LinkManager.addLink('goals', goal.id, 'schedule', newId);
            added++;
        }
        if (added) ScheduleApp.saveData();
        return added;
    },

    /**
     * Create the "Goal Review: <title>" routine — weekly, personal context,
     * no web (the goal's ground truth is the user's own data). The one
     * recipe both the goal page and the save_goal tool use, so UI-created
     * and agent-created routines never drift.
     */
    startWeeklyReview(goalTitle) {
        if (typeof ReviewRoutines === 'undefined' || !goalTitle) return null;
        const title = this.GOAL_REVIEW_PREFIX + goalTitle;
        const existing = ReviewRoutines.find(title);
        if (existing) return existing;
        return ReviewRoutines.start({
            title, body: this._reviewBody(goalTitle),
            interval: 'weekly', time: '09:00', web: false, useContext: true
        });
    },

    _reviewBody(goalTitle) {
        return `Review my goal "${goalTitle}". Call list_goals and look at the tasks linked to it: what got done since the last review, what is scheduled next, and how long it has been since anything moved. ` +
            'Check the goal\'s ageDays first: a goal only days old is JUST STARTING, never "stalled" — for a new goal, judge whether the first steps are scheduled and say it is under way. ' +
            'For an established goal, write a short honest read: is it moving, stalled, or done in all but name? If it is stalled, name the smallest next step worth scheduling. ' +
            'If nothing changed since the last review, say so in two sentences and stop.';
    },

    // The template startWeeklyReview wrote before the ageDays instruction
    // (2026-07-31) — kept verbatim so the healer below can recognize an
    // unmodified machine-authored body.
    _legacyReviewBody(goalTitle) {
        return `Review my goal "${goalTitle}". Look at the tasks linked to it: what got done since the last review, what is scheduled next, and how long it has been since anything moved. ` +
            'Write a short honest read: is it moving, stalled, or done in all but name? If it is stalled, name the smallest next step worth scheduling. ' +
            'If nothing changed since the last review, say so in two sentences and stop.';
    },

    /**
     * Refresh existing "Goal Review: <title>" routines whose body is still
     * the old machine-written template — a body the user edited is never
     * touched. Called once per session from GoalsPage.init.
     */
    refreshReviewBodies() {
        if (typeof NotePrompts === 'undefined') return;
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        for (const n of NotePrompts.list()) {
            if (!NotePrompts.isRoutine(n)) continue;
            const title = (n.title || '').trim();
            if (!title.startsWith(this.GOAL_REVIEW_PREFIX)) continue;
            const goalTitle = title.slice(this.GOAL_REVIEW_PREFIX.length);
            if (norm(NotePrompts.bodyText(n)) === norm(this._legacyReviewBody(goalTitle))) {
                NotePrompts.update(n.id, { body: this._reviewBody(goalTitle) });
            }
        }
    }
};
