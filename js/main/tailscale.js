'use strict';
/**
 * tailscale.js — reach this Mac's embedded relay from anywhere through
 * Tailscale Funnel (2026-09-08).
 *
 * The phone's transport ladder (js/adapter/mobile-sync.js) dials every URL
 * the Mac advertises before it falls back to the hosted Connect relay. On the
 * home network those are the Mac's LAN addresses. With Tailscale installed on
 * the Mac, `tailscale funnel --bg <relay port>` gives the same relay a PUBLIC
 * https address on the Mac's own MagicDNS name (`https://<mac>.<tailnet>.ts.net`,
 * a real certificate, TLS ending on this Mac, home IP hidden) — and the phone
 * needs nothing installed. This module finds the CLI, reads the current serve
 * config, turns the Funnel on/off for the relay port, and reports the wss URL
 * that main.js advertises alongside the LAN ones.
 *
 * Laws:
 *   - The pairing is the credential. Funnel only moves bytes to the relay; a
 *     stranger who finds the URL can open a socket and cannot finish the Noise
 *     handshake. The relay's host role stays loopback-only and (since today)
 *     refuses connections that arrive THROUGH the Funnel proxy, which hands
 *     them over from 127.0.0.1 — see lan-relay.mjs.
 *   - Nothing here runs unless the user asked (Settings › Paired Devices ›
 *     Reach from anywhere) or reads state that is already there. Detection is
 *     read-only: `tailscale serve status --json`.
 *   - Pure parsing (`funnelUrlFor`, `pickFunnelPort`) is pinned by
 *     tests/tailscale-test.js and must stay free of child_process.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');

const CLI_CANDIDATES = [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
];
// Funnel is only offered on these ports (the `funnel-ports` node capability).
const FUNNEL_PORTS = [443, 8443, 10000];

let cachedCli;
function findCli() {
    if (cachedCli !== undefined) return cachedCli;
    cachedCli = CLI_CANDIDATES.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
    return cachedCli;
}

function run(args, timeout = 8000) {
    const cli = findCli();
    if (!cli) return { ok: false, error: 'Tailscale is not installed on this Mac' };
    const r = spawnSync(cli, args, { encoding: 'utf8', timeout });
    if (r.error) return { ok: false, error: r.error.message };
    if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || `tailscale exited ${r.status}`).trim() };
    return { ok: true, out: r.stdout || '' };
}

/**
 * The port a `Proxy` handler target points at ("http://127.0.0.1:18436" →
 * 18436, "localhost:18436" → 18436, "18436" → 18436), or 0.
 */
function targetPort(target) {
    if (typeof target !== 'string') return 0;
    const m = /:(\d{1,5})(?:\/|$)/.exec(target) || /^(\d{1,5})$/.exec(target);
    return m ? Number(m[1]) : 0;
}

/**
 * Pure: given `tailscale serve status --json` (the ServeConfig) and the relay
 * port, return the public wss URL the Funnel exposes it on, or null. Only a
 * handler at "/" that proxies to OUR port and has Funnel allowed counts —
 * a tailnet-only `serve` entry is not reachable from a phone with nothing
 * installed, and a foreign handler is somebody else's service.
 */
function funnelUrlFor(config, relayPort) {
    if (!config || typeof config !== 'object' || !relayPort) return null;
    const web = config.Web || {};
    const allow = config.AllowFunnel || {};
    for (const hostPort of Object.keys(web)) {
        if (!allow[hostPort]) continue;
        const handlers = (web[hostPort] && web[hostPort].Handlers) || {};
        const root = handlers['/'];
        if (!root || targetPort(root.Proxy) !== Number(relayPort)) continue;
        const m = /^(.+?)(?::(\d+))?$/.exec(hostPort);
        if (!m) continue;
        const host = m[1].replace(/\.$/, '');
        const port = Number(m[2] || 443);
        return port === 443 ? `wss://${host}` : `wss://${host}:${port}`;
    }
    return null;
}

/**
 * Pure: the Funnel port to use — 443 unless the serve config already binds it
 * to something that is not our relay, then the next free one. Null when all
 * three are taken by other services.
 */
function pickFunnelPort(config, relayPort) {
    const web = (config && config.Web) || {};
    const tcp = (config && config.TCP) || {};
    for (const port of FUNNEL_PORTS) {
        const entries = Object.keys(web).filter(hp => Number((/:(\d+)$/.exec(hp) || [])[1] || 443) === port);
        const ours = entries.some(hp => {
            const root = ((web[hp] && web[hp].Handlers) || {})['/'];
            return root && targetPort(root.Proxy) === Number(relayPort);
        });
        const foreign = entries.some(hp => {
            const h = (web[hp] && web[hp].Handlers) || {};
            return Object.keys(h).some(p => p !== '/' || targetPort(h[p].Proxy) !== Number(relayPort));
        });
        const rawTcp = tcp[String(port)] && !tcp[String(port)].HTTPS;
        if (ours) return port;
        if (!foreign && !rawTcp) return port;
    }
    return null;
}

function readConfig() {
    const r = run(['serve', 'status', '--json']);
    if (!r.ok) return { ok: false, error: r.error, config: null };
    try { return { ok: true, config: JSON.parse(r.out || '{}') || {} }; }
    catch { return { ok: false, error: 'could not read the Tailscale serve config', config: {} }; }
}

/** Self node: MagicDNS name + whether the tailnet lets this node Funnel. */
function selfInfo() {
    const r = run(['status', '--json']);
    if (!r.ok) return { ok: false, error: r.error };
    try {
        const j = JSON.parse(r.out);
        const self = j.Self || {};
        const caps = Array.isArray(self.Capabilities) ? self.Capabilities
            : (self.CapMap && typeof self.CapMap === 'object' ? Object.keys(self.CapMap) : []);
        return {
            ok: true,
            online: !!self.Online,
            dnsName: String(self.DNSName || '').replace(/\.$/, ''),
            canFunnel: caps.includes('funnel') && caps.includes('https'),
            backendState: j.BackendState || '',
        };
    } catch { return { ok: false, error: 'could not read the Tailscale status' }; }
}

/**
 * What Settings shows and what main.js advertises:
 *   { installed, running, dnsName, canFunnel, url, port, error }
 * `url` is the wss address the relay is reachable on RIGHT NOW (null when the
 * Funnel is off), never a prediction.
 */
function status(relayPort) {
    const cli = findCli();
    if (!cli) return { installed: false, running: false, url: null, dnsName: '', canFunnel: false };
    const self = selfInfo();
    if (!self.ok) return { installed: true, running: false, url: null, dnsName: '', canFunnel: false, error: self.error };
    const cfg = readConfig();
    const url = cfg.ok ? funnelUrlFor(cfg.config, relayPort) : null;
    return {
        installed: true,
        running: self.backendState === 'Running' && self.online,
        dnsName: self.dnsName,
        canFunnel: self.canFunnel,
        url,
        port: url ? Number((/:(\d+)$/.exec(url) || [])[1] || 443) : 0,
        error: cfg.ok ? undefined : cfg.error,
    };
}

/** Turn the Funnel on for the relay port. Returns status() afterwards. */
function enable(relayPort) {
    if (!relayPort) return { error: 'The Mac relay is not running' };
    const self = selfInfo();
    if (!self.ok) return { error: self.error };
    if (!self.canFunnel) return { error: 'Funnel is not enabled for this Mac in your Tailscale admin console (the node needs the "funnel" attribute and HTTPS certificates turned on).' };
    const cfg = readConfig();
    const port = pickFunnelPort(cfg.ok ? cfg.config : {}, relayPort);
    if (!port) return { error: 'Tailscale Funnel ports 443, 8443 and 10000 are all in use by other services on this Mac.' };
    const r = run(['funnel', '--bg', `--https=${port}`, String(relayPort)], 30000);
    if (!r.ok) return { error: r.error };
    return status(relayPort);
}

/** Turn the Funnel off (clears only the port that carries our relay). */
function disable(relayPort) {
    const cfg = readConfig();
    const url = cfg.ok ? funnelUrlFor(cfg.config, relayPort) : null;
    if (!url) return status(relayPort);
    const port = Number((/:(\d+)$/.exec(url) || [])[1] || 443);
    const r = run(['funnel', '--bg', `--https=${port}`, 'off'], 30000);
    if (!r.ok) return { error: r.error };
    return status(relayPort);
}

module.exports = { findCli, status, enable, disable, funnelUrlFor, pickFunnelPort, targetPort, FUNNEL_PORTS };
