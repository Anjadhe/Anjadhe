/**
 * MCP call arguments, adjusted at the boundary (main) before a tool call
 * reaches its server. Pure; pinned by tests/mcp-args-test.js.
 *
 * browser_take_screenshot (Playwright MCP): given a `filename`, the server
 * saves the image to disk and answers with only a markdown link to the file
 * — no image block — so a brain that can see never sees the screenshot it
 * asked for (2026-09-13: every screenshot in an Amazon run went to disk and
 * the model fell back to scraping the DOM with browser_evaluate). Small
 * models pass a filename because the schema offers one. Without it the
 * server still saves a copy AND returns the image, which is the whole point
 * of the call for the assistant.
 */
function prepareToolArgs(toolName, args) {
    const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
    if (toolName === 'browser_take_screenshot' && Object.prototype.hasOwnProperty.call(a, 'filename')) {
        const { filename, ...rest } = a;
        return rest;
    }
    return a;
}

module.exports = { prepareToolArgs };
