// Minimal Streamable-HTTP MCP server for C8.7 harness.
// - requires Authorization: Bearer secret123 (401 otherwise)
// - initialize returns Mcp-Session-Id header
// - tools/list answers as an SSE stream (exercises the SSE response parser)
// - tools/call answers as plain JSON (echo tool)
const http = require('http');

const PORT = 18990;
const SESSION = 'sess-' + Math.random().toString(36).slice(2);

http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  if (req.headers.authorization !== 'Bearer secret123') { res.writeHead(401).end('missing token'); return; }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': SESSION });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'c87-test-server', version: '1.0' }
      } }));
      return;
    }
    if (msg.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    if (req.headers['mcp-session-id'] !== SESSION) { res.writeHead(400).end('bad session'); return; }
    if (msg.method === 'tools/list') {
      // SSE-framed response: spec-legal and exercises the client's parser.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const payload = { jsonrpc: '2.0', id: msg.id, result: { tools: [{
        name: 'echo', description: 'Echoes text back',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
      }] } };
      res.write(': keepalive\n\n');
      res.write('event: message\ndata: ' + JSON.stringify(payload) + '\n\n');
      res.end();
      return;
    }
    if (msg.method === 'tools/call') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: `ECHO:${msg.params?.arguments?.text || ''}` }]
      } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'unknown method' } }));
  });
}).listen(PORT, '127.0.0.1', () => console.log('mcp-test-server ready on ' + PORT));
