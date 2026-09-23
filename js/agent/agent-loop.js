/* AgentLoop — one small model⇄tool loop (2026-09-21).
 *
 * The runner for workroom agents: the master and every specialist are this
 * same loop with a different prompt and tool list. It exists so that work
 * which is not a chat does not have to live inside AgentService's chat loop,
 * which had grown ~40 `opts.specialist` branches to carry it.
 *
 * What it does, and all it does:
 *   - calls the brain through LLMLogger (routing, the ledger and the
 *     data-class gate come with it), retrying a transient error;
 *   - runs tool calls one at a time through the `execute` it is given;
 *   - hands a tool's picture to a model that can see, keeping only the
 *     LATEST picture in the transcript;
 *   - folds old tool results so a long job fits a small context;
 *   - reads an `inbox` between turns, so something the user says mid-run
 *     reaches the agent instead of restarting it;
 *   - stops on a step or time budget with one tools-free turn that writes
 *     the answer from what it has.
 *
 * What it does NOT do: decide what a tool may do (that is `execute`'s job and
 * main's), repair JSON (nothing here asks for JSON), or know what any tool
 * is about. A `guard` may watch results and stop the loop; its reason is
 * returned as `stop: 'guard'` so the CALLER, not the model, says why.
 */
const AgentLoop = {
    RESULT_CHARS: 6000,     // one tool result, as the model first sees it
    FOLDED_CHARS: 280,      // the same result once it is history
    KEEP_FULL: 2,           // newest tool results kept whole whatever their size
    KEEP_CHARS: 12000,      // …and older ones too, while they fit this much
    FOLD_PROSE: 90,         // a scalar string longer than this is prose, not a fact
    TRANSIENT: /not running|no server|still loading|loading the model|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|network|overloaded|\b5\d\d\b/i,

    _serialize(result) {
        if (typeof result === 'string') return result;
        const { images, waitedMs, ...rest } = result || {};
        let text; try { text = JSON.stringify(rest); } catch { text = String(rest); }
        return text;
    },
    /* Old tool results shrink; only the newest picture survives. A result is
     * kept WHOLE while the kept ones fit a character budget, newest first —
     * position alone folded a 400-character calendar read as eagerly as a 6 KB
     * page look, and a job made of small reads lost nearly all of them. */
    _fold(messages) {
        const toolAt = [], imageAt = [];
        messages.forEach((message, index) => {
            if (message.role === 'tool') toolAt.push(index);
            if (message.role === 'user' && Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')) imageAt.push(index);
        });
        let room = this.KEEP_CHARS;
        for (const [rank, index] of [...toolAt].reverse().entries()) {
            const message = messages[index];
            if (message.folded) continue;
            const body = String(message.content);
            if (rank < this.KEEP_FULL || body.length <= room) { room -= body.length; continue; }
            message.folded = true;
            message.content = this._foldContent(body, this.FOLDED_CHARS);
        }
        for (const index of imageAt.slice(0, -1)) messages[index].content = '(An earlier picture of the page was here. Only the latest one is kept.)';
    },
    /* A folded result keeps FACTS, not preamble, and never a half one. Results
     * are usually {metadata…, items:[…]}, so slicing the first N characters
     * kept the metadata and threw the items away: a calendar read folded down
     * to from/to/timezone/note plus half of the first event's id, and the
     * agent — told to answer from what it still had — invented the meetings.
     * Fold by SHAPE instead: drop long prose, keep whole items while they fit,
     * and SAY how many were dropped, so "I no longer have this" can never read
     * as "there was nothing there". */
    _foldContent(body, limit) {
        if (body.length <= limit) return body;
        let value = null; try { value = JSON.parse(body); } catch { /* not JSON */ }
        if (value && typeof value === 'object') {
            const list = Array.isArray(value) ? value : null;
            const head = {}; let items = list, itemsKey = null;
            if (!list) {
                for (const [key, field] of Object.entries(value)) {
                    if (Array.isArray(field)) { if (!items || field.length > items.length) { items = field; itemsKey = key; } continue; }
                    if (typeof field === 'string' && field.length > this.FOLD_PROSE) continue;
                    head[key] = field;
                }
                for (const [key, field] of Object.entries(value)) if (Array.isArray(field) && key !== itemsKey) head[key] = `(${field.length} not kept)`;
            }
            const kept = [];
            let room = limit - JSON.stringify(list ? [] : head).length - 64;   // room for the "N not kept" line
            for (const item of items || []) {
                const text = JSON.stringify(item);
                if (text.length > room) break;
                kept.push(item); room -= text.length + 1;
            }
            const dropped = (items || []).length - kept.length;
            let out;
            if (list) { out = kept.slice(); if (dropped) out.push(`…${dropped} more, not kept — read again if you need them`); }
            else { out = { ...head, ...(itemsKey ? { [itemsKey]: kept } : {}) }; if (dropped) out.folded = `${dropped} more not kept — read again if you need them`; }
            const text = JSON.stringify(out);
            if (text.length <= Math.max(limit, 240) + 64) return text;
        }
        return `${body.slice(0, limit)}… (earlier result, shortened)`;
    },
    async _model(source, params, aborted) {
        let response = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (aborted()) return { aborted: true };
            try { response = await LLMLogger.call(source, { ...params, messages: params.messages.map(({ folded, ...message }) => message) }); }
            catch (error) { response = { error: error.message || String(error) }; }
            if (!response?.error || response.blocked) return response;
            const wait = (typeof AgentService !== 'undefined' && AgentService.throttleWaitFrom?.(response)) || 0;
            if (!wait && !this.TRANSIENT.test(response.error)) return response;
            await new Promise(resolve => setTimeout(resolve, wait ? Math.min(wait, 75000) : 2500 * (attempt + 1)));
        }
        return response;
    },

    /**
     * @returns {{ text, stop, error?, reason?, steps, calls }}
     *   stop: 'done' | 'steps' | 'budget' | 'guard' | 'aborted' | 'error'
     */
    async run({ source = 'workrooms', subject = null, system, input, images = [], tools = [], execute, maxSteps = 12, budgetMs = 180000,
        maxTokens = 1200, vision = false, guard = null, aborted = () => false, inbox = () => [], onEvent = () => {}, privateChat = false } = {}) {
        const started = Date.now();
        let waited = 0, calls = 0, steps = 0;
        const first = images.length && vision
            ? [{ type: 'text', text: input }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))] : input;
        const messages = [{ role: 'system', content: system }, { role: 'user', content: first }];
        const params = extra => ({
            model: typeof AgentService !== 'undefined' ? AgentService.model : undefined, think: false, logTag: source,
            ...(subject ? { activitySubject: String(subject).slice(0, 120) } : {}), ...(privateChat ? { privateChat: true } : {}),
            options: { num_predict: maxTokens, ...(typeof AgentService !== 'undefined' ? { num_ctx: AgentService.numCtx || 8192 } : {}) },
            maxTokens, messages, ...extra });
        const finish = async (stop, note) => {
            // One tools-free turn: research is over, write it down.
            // Older results above were shortened, so "what you already have" is
            // not everything you read. Say so, or the gap gets filled in.
            messages.push({ role: 'user', content: `${note} Do not call a tool. Write your answer now from what you already have. Older tool results above were shortened to save room: anything you cannot still read in full is something you no longer have, so do not restate it from memory — name only what is in front of you and say plainly what is unfinished, unverified or no longer visible.` });
            this._fold(messages);
            const response = await this._model(source, params({}), aborted);
            const text = String(response?.message?.content || '').trim();
            return { text, stop, steps, calls, ...(response?.error ? { error: response.error } : {}) };
        };

        for (; steps < maxSteps; steps++) {
            if (aborted()) return { text: '', stop: 'aborted', steps, calls };
            for (const said of inbox() || []) messages.push({ role: 'user', content: `The user just added: ${said}` });
            if (Date.now() - started - waited > budgetMs) return finish('budget', 'You are out of time for this job.');
            this._fold(messages);
            const response = await this._model(source, params(tools.length ? { tools } : {}), aborted);
            if (response?.aborted || aborted()) return { text: '', stop: 'aborted', steps, calls };
            if (response?.error) return { text: '', stop: 'error', error: response.error, steps, calls };
            const message = response.message || {};
            const toolCalls = (message.tool_calls || []).slice(0, 4);
            toolCalls.forEach((call, index) => { if (!call.id) call.id = `call_${Date.now().toString(36)}_${steps}_${index}`; });
            messages.push({ role: 'assistant', content: message.content || '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
            if (!toolCalls.length) {
                const text = String(message.content || '').trim();
                if (text) return { text, stop: 'done', steps, calls };
                messages.push({ role: 'user', content: 'Your reply was empty. Either call a tool or write your answer.' });
                continue;
            }
            const pictures = [];
            for (const [index, call] of toolCalls.entries()) {
                const name = call.function?.name;
                let args = call.function?.arguments;
                if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
                if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
                if (aborted()) return { text: '', stop: 'aborted', steps, calls };
                calls++;
                await onEvent({ type: 'tool', phase: 'start', name, args });
                let result;
                if (!tools.some(def => def.function?.name === name)) {
                    result = { error: `There is no tool called “${name}”. You have: ${tools.map(def => def.function.name).join(', ')}.` };
                } else {
                    try { result = await execute(name, args, { step: steps, index }); }
                    catch (error) { result = { error: error.message || String(error) }; }
                }
                waited += Number(result?.waitedMs) || 0;
                const failed = !!(result && (result.error || result.denied || result.isError));
                await onEvent({ type: 'tool', phase: failed ? 'error' : 'ok', name, args, result });
                for (const image of result?.images || []) if (typeof image?.dataUrl === 'string' && /^data:image\//.test(image.dataUrl)) pictures.push(image.dataUrl);
                let content = this._serialize(result);
                if (content.length > this.RESULT_CHARS) content = `${content.slice(0, this.RESULT_CHARS)}… (cut: ask for less at a time)`;
                messages.push({ role: 'tool', tool_call_id: call.id, name, content });
                const halt = guard?.observe(name, args, result);
                if (halt) return { text: String(message.content || '').trim(), stop: 'guard', reason: halt, steps: steps + 1, calls };
            }
            if (pictures.length && vision) {
                messages.push({ role: 'user', content: [{ type: 'text', text: 'Picture from the last step. Numbers drawn on it match the numbered list.' },
                    { type: 'image_url', image_url: { url: pictures.at(-1) } }] });
            }
        }
        return finish('steps', 'You have used all your steps for this job.');
    }
};
if (typeof module !== 'undefined') module.exports = AgentLoop;
