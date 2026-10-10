/**
 * set_up_browser — nenva sets up its own Chrome window itself (2026-10-07,
 * docs/TEACH.md "Setting up the browser").
 *
 * Ram: "technically it should be a capability of the agent to install the
 * extension and do all the things necessary." Google Chrome will not load an
 * extension without a person's click (the --load-extension flag is ignored
 * in branded builds since Chrome 137; checked against Chrome 154 on
 * 2026-10-07), so the extension ships from the Chrome Web Store and the one
 * click left is Chrome's own "Add to Chrome". Everything around it is the
 * app's: the dedicated profile, the native-messaging host, opening the
 * listing in that profile, noticing the connection, and from then on
 * reloading the extension itself when the app updates it.
 *
 * One tool in its own `browser` group, loaded on demand. Not an ask: it
 * opens a window and changes nothing else. It refuses an ambient run.
 */
(function registerBrowserSetupTool() {
    if (typeof AgentTools === 'undefined') return;
    const GROUP = 'browser';
    AgentTools.GROUP_INFO[GROUP] = 'set up nenva\'s own Chrome window (install its extension) when a browser job, a recording or a taught task says Chrome is not connected; also tells whether it is connected';
    const plain = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

    AgentTools.register({ type: 'function', function: {
        name: 'set_up_browser',
        description: 'Set up nenva\'s own Chrome window, or check it. Call it whenever a tool says "Chrome is not connected" or asks to set up the browser, or when the user asks to. It opens Google Chrome on a profile kept for nenva, on the page where its extension is added with one click, and waits up to a minute for the extension to connect. Tell the user exactly what the result says to do.',
        parameters: { type: 'object', properties: {
            waitSeconds: { type: 'integer', description: 'How long to wait for the connection (default 60, at most 90).' }
        }, additionalProperties: false }
    } }, async function set_up_browser(args, ctx) {
        if (ctx && ctx.ambient) return { error: 'The browser is set up from a chat with the user present.' };
        let result;
        try { result = await window.electronAgentBrowser.command('chrome-setup', { waitMs: Math.min(90, Math.max(5, Number(args?.waitSeconds) || 60)) * 1000 }); }
        catch (error) { return { error: plain(error) }; }
        if (result.chromeMissing) return { connected: false, error: 'Google Chrome is not installed on this Mac. nenva\'s browser runs in Chrome: the user installs it from google.com/chrome, then asks again.' };
        if (result.already) return { connected: true, note: 'nenva\'s browser is connected and ready.' };
        if (result.connected) return { connected: true, note: 'Connected: the extension was added and nenva\'s browser is ready. Carry on with what the user asked.' };
        if (result.mode === 'store') return { connected: false, note: `A Chrome window opened on the nenva extension's page in the Chrome Web Store. Tell the user, in one line: press “Add to Chrome” there (and Add extension if Chrome asks). nenva connects on its own the moment it is added; then they can ask again.` };
        return { connected: false, note: `A Chrome window opened on chrome://extensions and the extension's folder is shown in Finder. Tell the user these three steps, in one short list: turn on Developer mode (top right), press Load unpacked and choose the folder shown in Finder, then click the nenva extension's icon in Chrome and press Connect. nenva notices when it connects.`, extensionPath: result.extensionPath };
    }, { source: 'browser-setup', group: GROUP, blockUntrusted: true, readOnly: true });
})();
