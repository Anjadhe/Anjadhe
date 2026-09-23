'use strict';
async function refresh() {
    const state = await chrome.runtime.sendMessage({ kind: 'state' });
    document.getElementById('state').textContent = !state.connected ? 'Open nenva and choose Browser setup, then Connect.'
        : state.control === 'agent' ? 'Connected. The agent is working.' : 'Connected. You are in control. Return to nenva and Continue when ready.';
}
for (const kind of ['connect', 'takeover']) document.getElementById(kind).onclick = async () => {
    await chrome.runtime.sendMessage({ kind }); await refresh();
};
refresh().catch(() => { document.getElementById('state').textContent = 'Reload this extension, then reconnect.'; });
setInterval(() => refresh().catch(() => {}), 1000);

