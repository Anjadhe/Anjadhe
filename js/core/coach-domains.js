/**
 * CoachDomains — what a coached goal can be about, and the know-how the
 * assistant brings to each (docs/COACH.md §5, 2026-10-09).
 *
 * A domain is a word on a goal (`Commitments.DOMAINS`, CO11) and a GUIDANCE
 * note here: know-how, not rules (like a playbook). No threshold, streak
 * rule or score lives in this file; the assistant reads the note and judges.
 * `plan_outcome` reads it when a goal is planned, and the Coach agent's look
 * will read the same note, so planning and coaching speak alike.
 *
 * `intro` is how the area is introduced on Now before the person has a goal
 * in it (Coach.intros, one area a day): code’s words, opening a chat
 * that plans one.
 *
 * `measures` names the figures people in this domain usually keep, offered
 * as names to reuse so one goal's readings line up; the person's own words
 * decide what is actually kept (CO2).
 */
const CoachDomains = {
    LIST: [
        {
            id: 'fitness', label: 'Fitness',
            intro: { title: 'Training for something?', body: 'Tell me the goal, like a 10K by spring. I plan it around your week one stage at a time, ask how each session went, and adjust when a week goes sideways.', offer: 'Plan a fitness goal', prompt: 'I’d like help with a fitness goal. Ask me what I’m working toward, then plan it with me around my week.' },
            measures: 'distance (mi or km), duration (min), pace (min per mi), weight lifted (lb or kg), sessions',
            guidance: 'Build gradually: raise the load a little each stage, never all at once, and keep at least one rest day a week. Plan the next one or two stages, not the whole road. When a session is missed, prefer moving it to a free slot this week over dropping it, and after a hard or sick week ease the next stage instead of catching up. Fit sessions around the person\'s real calendar. Notice and say a milestone once (a longest run, a first week with every session done). Pain that is sharp, or that lasts, is a reason to rest and see a professional, not to push through.'
        },
        {
            id: 'health', label: 'Health',
            intro: { title: 'A healthier habit?', body: 'Sleep, steps, weight, blood pressure: tell me what you want to change. I help you move it in small steps and keep the readings you tell me. Coaching on habits, never medical advice.', offer: 'Start a health goal', prompt: 'I’d like help with a health habit. Ask me what I want to change, then plan it with me in small steps.' },
            measures: 'weight (lb or kg), systolic and diastolic (mmHg), pulse (bpm), glucose (mg/dL), sleep (h), bedtime (time), steps',
            guidance: 'This is coaching on habits, never medical advice: never diagnose, never suggest starting, stopping or changing a medication or a dose, and never set a target for a clinical reading (blood pressure, glucose) yourself; the person\'s own clinician\'s target, if they say one, is theirs. Move habits in small steps (bedtime 15 minutes earlier at a time, a few hundred more steps). Read the calendar for what gets in the way. A worrying report (chest pain, fainting, a reading far outside what they usually say) is not coached: say to contact a doctor, and in an emergency the local emergency number.'
        },
        {
            id: 'money', label: 'Money',
            intro: { title: 'Saving toward something?', body: 'An emergency fund, a trip, paying down a card: tell me the amount and the date. I work out what it takes each month and show how far you’ve come, alongside the bills and renewals I find.', offer: 'Set a money goal', prompt: 'I’d like help with a money goal. Ask me what I’m saving or paying down, how much and by when, then plan it with me.' },
            measures: 'saved ($), balance ($), spent ($), paid down ($)',
            guidance: 'Work from the money facts nenva holds (money_overview), never from guesses. A savings or payoff goal moves by a monthly amount the person can actually keep; say what it takes per month to arrive on time. Never predict a price, call the market or promise a return. Nothing is paid, moved, bought or sold from here.'
        },
        {
            id: 'parenting', label: 'Parenting',
            intro: { title: 'More time with your kids?', body: 'Reading together, screen time, a bedtime routine: I fit it around school, activities and work, and help when the same days keep falling through.', offer: 'Plan family time', prompt: 'I’d like help with a parenting goal. Ask me what I want to do with my kids, then plan it with me around our week.' },
            measures: 'time together (min), books read, screen time (min)',
            guidance: 'The goal is the parent\'s (time together, reading, routines, screen time), planned around the family\'s real calendar: school, activities, work. Small and regular beats big and rare. When sessions keep falling through on the same days, the calendar usually says why (practice, a late meeting): offer to move them to the days that work. Never judge the child or the parent, and never compare children. This is not child development, medical or therapy advice; a worry about a child\'s health, development or safety goes to their doctor or the right professional.'
        },
        {
            id: 'learning', label: 'Learning',
            intro: { title: 'Learning something new?', body: 'A language, an instrument, a course: I plan short, regular sessions toward your date and notice when practice slips.', offer: 'Plan your learning', prompt: 'I’d like help learning something. Ask me what and by when, then plan short sessions with me around my week.' },
            measures: 'practice (min), lessons, pages, words learned',
            guidance: 'Short, regular sessions beat long rare ones. Each session revisits a little of what came before before adding something new. Measure by what the person can now do (hold a conversation, play the piece, pass the practice test), not by hours logged. Plan toward the finish date if there is one, and say plainly when the pace will not get there.'
        }
    ],

    get(id) { return this.LIST.find(d => d.id === id) || null; },
    label(id) { const d = this.get(id); return d ? d.label : ''; },
    /** The note for a domain as lines for a prompt or a tool result; [] for none. */
    lines(id) {
        const d = this.get(id);
        return d ? [`How to coach ${d.label.toLowerCase()} (know-how, use judgment): ${d.guidance}`, `Figures people usually keep here: ${d.measures}.`] : [];
    }
};

if (typeof module !== 'undefined') module.exports = CoachDomains;
