/**
 * lan-relay.mjs — the Mac's own relay, on the home network.
 * =========================================================
 * The same zero-knowledge rendezvous protocol as the hosted relay
 * (Anjadhe Connect `/v1/relay`) and the standalone dev relay
 * (relay/server.js), embedded in the Electron main process and bound to
 * the LAN. A paired phone on the same network connects here directly —
 * `ws://<mac-lan-ip>:<port>/<routingId>` — instead of round-tripping
 * through the hosted relay; the Mac's own host endpoint connects over
 * loopback. Same frames, same Noise channel on top, so the endpoints
 * cannot tell which relay they met on.
 *
 * PROTOCOL LOCKSTEP: this file, relay/server.js and the Connect relay
 * implement one protocol (documented in relay/server.js). A change to the
 * envelope must land in all three.
 *
 * Two deliberate differences from the standalone relay:
 *   - the `host` role is accepted from LOOPBACK connections only. The
 *     only legitimate host is this Mac; without the check, any device on
 *     the network that learned the routing id could squat the host slot
 *     before the Mac claimed it (a LAN-only denial of service — the
 *     Noise handshake would still fail against an impostor).
 *   - frames are capped at 32 MiB (the Node relay's cap), so chunking
 *     almost never engages on the LAN path.
 *
 * Main-process only (imports `ws`); never bundled for the phone.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_ROUTING_ID = 128;

const LOOPBACK_RX = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

/**
 * Start the LAN relay. Binds all interfaces on `port` (0 = ephemeral).
 * Returns { ready, port(), close } — `ready` resolves with the bound port.
 */
export function startLanRelay(port = 0) {
  // routingId -> { host: ws|null, hostKey, clients: Map<clientId, ws> }
  const rooms = new Map();

  function getRoom(id) {
    let r = rooms.get(id);
    if (!r) { r = { host: null, hostKey: null, clients: new Map() }; rooms.set(id, r); }
    return r;
  }
  function pruneRoom(id) {
    const r = rooms.get(id);
    if (r && !r.host && r.clients.size === 0) rooms.delete(id);
  }
  function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    res.writeHead(426); res.end('upgrade required');
  });

  const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });

  wss.on('connection', (ws, req) => {
    ws.meta = null; // set once the hello handshake succeeds
    ws.isLoopback = LOOPBACK_RX.test((req.socket && req.socket.remoteAddress) || '');

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { return send(ws, { t: 'error', message: 'bad json' }); }

      if (!ws.meta) return handleHello(ws, msg);
      if (msg.t === 'data') return forward(ws, msg);
      // unknown post-handshake messages are ignored
    });

    ws.on('close', () => unregister(ws));
    ws.on('error', () => { try { ws.close(); } catch { /* already closing */ } });
  });

  function handleHello(ws, msg) {
    const okRole = msg.role === 'host' || msg.role === 'client';
    const okId = typeof msg.routingId === 'string'
      && msg.routingId.length > 0 && msg.routingId.length <= MAX_ROUTING_ID;
    if (msg.t !== 'hello' || !okRole || !okId) {
      send(ws, { t: 'error', message: 'expected valid hello' });
      return ws.close();
    }
    const room = getRoom(msg.routingId);
    if (msg.role === 'host') {
      if (!ws.isLoopback) {
        send(ws, { t: 'error', message: 'host role is local-only' });
        return ws.close();
      }
      // Host continuity, mirroring the hosted relay: a live keyed host is
      // only replaced by a reconnect presenting the same key.
      const givenKey = typeof msg.hostKey === 'string' && msg.hostKey.length <= 128
        ? msg.hostKey : null;
      if (room.host && room.host !== ws && room.hostKey && givenKey !== room.hostKey) {
        send(ws, { t: 'error', message: 'host slot held' });
        return ws.close();
      }
      if (room.host && room.host !== ws) { try { room.host.close(); } catch { /* stale */ } }
      room.host = ws;
      room.hostKey = givenKey;
      ws.meta = { routingId: msg.routingId, role: 'host' };
      send(ws, { t: 'welcome' });
      for (const clientId of room.clients.keys()) send(ws, { t: 'peer-join', clientId });
    } else {
      const clientId = crypto.randomBytes(8).toString('hex');
      room.clients.set(clientId, ws);
      ws.meta = { routingId: msg.routingId, role: 'client', clientId };
      send(ws, { t: 'welcome', clientId });
      send(ws, { t: 'host-state', online: !!room.host });
      send(room.host, { t: 'peer-join', clientId });
    }
  }

  function unregister(ws) {
    if (!ws.meta) return;
    const { routingId, role, clientId } = ws.meta;
    const room = rooms.get(routingId);
    if (!room) return;
    if (role === 'host') {
      if (room.host === ws) {
        room.host = null;
        room.hostKey = null;
        for (const c of room.clients.values()) send(c, { t: 'host-state', online: false });
      }
    } else {
      room.clients.delete(clientId);
      send(room.host, { t: 'peer-leave', clientId });
    }
    pruneRoom(routingId);
  }

  function forward(ws, msg) {
    if (typeof msg.payload !== 'string') return; // opaque ciphertext only
    const { routingId, role, clientId } = ws.meta;
    const room = rooms.get(routingId);
    if (!room) return;
    if (role === 'client') {
      send(room.host, { t: 'data', from: clientId, payload: msg.payload });
    } else {
      send(room.clients.get(msg.to), { t: 'data', payload: msg.payload });
    }
  }

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject); // EADDRINUSE and friends — caller decides
    server.listen(port, () => resolve(server.address().port));
  });

  function close() {
    for (const ws of wss.clients) { try { ws.terminate(); } catch { /* gone */ } }
    wss.close();
    server.close();
  }

  return {
    ready,
    port: () => (server.address() ? server.address().port : 0),
    close,
  };
}
