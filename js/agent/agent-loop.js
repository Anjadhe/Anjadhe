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
    KEEP_FULL: 2,           // most recent tool results kept unfolded
    TRANSIENT: /not running|no server|still loading|loading the model|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|network|overloaded|\b5\d\d\b/i,

    _serialize(result) {
        if (typeof result === 'string') return result;
        const { images, waitedMs, ...rest } = result || {};
        let text; try { text = JSON.stringify(rest); } catch { text = String(rest); }
        return text;
    },
    /** Old tool results shrink to a line; only the newest picture survives. */
    _fold(messages) {
        const toolAt = [], imageAt = [];
        messages.forEach((message, index) => {
            if (message.role === 'tool') toolAt.push(index);
            if (message.role === 'user' && Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')) imageAt.push(index);
        });
        for (const index of toolAt.slice(0, -this.KEEP_FULL)) {
            const message = messages[index];
            if (message.folded) continue;
            message.folded = true;
            const body = String(message.content);
            if (body.length > this.FOLDED_CHARS) message.content = `${body.slice(0, this.FOLDED_CHARS)}… (earlier result, shortened)`;
        }
        for (const index of imageAt.slice(0, -1)) messages[index].content = '(An earlier picture of the page was here. Only the latest one is kept.)';
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
            messages.push({ role: 'user', content: `${note} Do not call a tool. Write your answer now from what you already have, and say plainly what is unfinished or unverified.` });
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
