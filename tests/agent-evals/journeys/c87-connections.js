/**
 * C8.7 regression net — hosted MCP transport + preset honesty.
 * The runner starts fixtures/mcp-test-server.js on 127.0.0.1:18990.
 */
module.exports = [
  {
    id: 'c87-url-validation',
    name: 'bad server URLs are refused with plain copy',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const bad = (await window.electronMCP.addServer({ name: 'ev-bad', url: 'ftp://x' })).error;
        const none = (await window.electronMCP.addServer({ name: 'ev-none' })).error;
        const pass = /http\(s\)/.test(bad || '') && /command or a server URL/.test(none || '');
        return { pass, detail: JSON.stringify({ bad, none }) };
      });
    }
  },
  {
    id: 'c87-http-transport',
    name: 'streamable HTTP end-to-end: 401 copy, session, SSE list, call',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        await window.electronMCP.addServer({ name: 'ev-wrong', url: 'http://127.0.0.1:18990/mcp', headers: { Authorization: 'Bearer WRONG' } });
        const bad = await window.electronMCP.testServer('ev-wrong');
        await window.electronMCP.removeServer('ev-wrong');
        await window.electronMCP.addServer({ name: 'ev-http', url: 'http://127.0.0.1:18990/mcp', headers: { Authorization: 'Bearer secret123' } });
        const test = await window.electronMCP.testServer('ev-http');
        const call = await window.electronMCP.callTool('ev-http', 'echo', { text: 'eval-trip' });
        await window.electronMCP.removeServer('ev-http');
        const pass = /rejected the request \(401\)/.test(bad.error || '')
          && test.serverInfo?.name === 'c87-test-server'
          && (test.tools || []).some(t => t.name === 'echo')
          && /ECHO:eval-trip/.test(call?.result || '');
        return { pass, detail: JSON.stringify({ bad: bad.error, tools: (test.tools || []).length, call: call?.result }) };
      });
    }
  },
  {
    id: 'c87-runtime-honesty',
    name: 'checkRuntime answers truthfully for missing and present binaries',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const fake = await window.electronMCP.checkRuntime('surely-not-a-real-binary-xyz');
        const sh = await window.electronMCP.checkRuntime('sh');
        return { pass: fake.found === false && sh.found === true, detail: JSON.stringify({ fake, sh }) };
      });
    }
  },
  {
    id: 'c87-preset-token-gate',
    name: 'preset cards render; token presets refuse an empty Add',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        AppManager.openApp('settings');
        await new Promise(r => setTimeout(r, 700));
        await SettingsApp._loadMCPServers();
        await new Promise(r => setTimeout(r, 300));
        const rows = [...document.querySelectorAll('[data-mcp-preset-row]')].map(el => el.dataset.mcpPresetRow);
        const tokenField = !!document.querySelector('[data-mcp-preset-row="github"] [data-preset-token]');
        document.querySelector('[data-mcp-preset-row="github"] button[data-mcp-preset]')?.click();
        await new Promise(r => setTimeout(r, 400));
        const notAdded = !(await window.electronMCP.listServers()).some(s => s.name === 'github');
        const pass = ['browser', 'deepwiki', 'context7', 'github'].every(n => rows.includes(n)) && tokenField && notAdded;
        return { pass, detail: JSON.stringify({ rows, tokenField, notAdded }) };
      });
    }
  }
];
