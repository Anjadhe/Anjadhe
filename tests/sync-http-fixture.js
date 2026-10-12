'use strict';
// Test-only ciphertext mailbox. Loopback + public fixture identities only;
// not a Connect implementation, production enrollment or server acceptance test.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), crypto = require('node:crypto');
const Database = require('better-sqlite3');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nenva-http-mailbox-'));
const db = new Database(path.join(folder, 'mailbox.sqlite'));
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE envelopes(cursor INTEGER PRIMARY KEY, writer TEXT, sequence INTEGER, payload TEXT, UNIQUE(writer, sequence)); CREATE TABLE receipts(writer TEXT PRIMARY KEY, payload TEXT)');
const publicPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const publicWriters = require('../fixtures/encrypted-operation/public-writers.json');
const keys = Object.fromEntries(Object.entries(publicWriters).map(([id, key]) => [id,
    crypto.createPublicKey({key:Buffer.concat([publicPrefix,Buffer.from(key,'hex')]),format:'der',type:'spki'})]));
const credentials = new Map([['Bearer nsync_'+'1'.repeat(64),'a'],['Bearer nsync_'+'2'.repeat(64),'b']]);
const fail = () => { throw Error('invalid_envelope'); };
function verify(e, writer) {
    if (!e || Object.keys(e).sort().join(',') !== 'ciphertext,datasetId,deviceId,membershipEpoch,nonce,protocolVersion,sequence,signature,tag' ||
        e.protocolVersion !== 2 || e.datasetId !== 'fixture' || e.membershipEpoch !== 1 || e.deviceId !== writer || !Number.isSafeInteger(e.sequence) || e.sequence < 1) fail();
    const decode = (v, lo, hi = lo) => {
        if (typeof v !== 'string' || !v.length || v.length > Math.ceil(hi*4/3) || /[^A-Za-z0-9_-]/.test(v)) fail();
        const bytes=Buffer.from(v,'base64url'); if(bytes.length<lo || bytes.length>hi || bytes.toString('base64url')!==v) fail(); return bytes;
    };
    const header=Buffer.from(`nenva-sync-operation-v2\nfixture\n1\n${writer}\n${e.sequence}\n`);
    const signed=Buffer.concat([Buffer.from('nenva-sync-signature-v2\n'),header,decode(e.nonce,12),decode(e.ciphertext,1,1048576),decode(e.tag,16)]);
    if(!crypto.verify(null,signed,keys[writer],decode(e.signature,64))) fail();
}
function send(response, status, value) { response.writeHead(status, {'Content-Type':'application/json'}); response.end(JSON.stringify(value)); }
const server=http.createServer(async (request,response)=>{
    try {
        const writer=credentials.get(request.headers.authorization);
        if(!writer || request.headers['x-sync-epoch']!=='1') return send(response,401,{error:'unauthorized'});
        const url=new URL(request.url,'http://127.0.0.1');
        if(!['/v2/sync/datasets/fixture/operations','/v2/sync/datasets/fixture/receipts'].includes(url.pathname)) return send(response,404,{error:'request_failed'});
        if(request.method==='GET' && url.pathname.endsWith('operations')) {
            const cursor=url.searchParams.get('after') || '0';
            if(!/^(0|[1-9][0-9]{0,8})$/.test(cursor)) return send(response,400,{error:'invalid_cursor'});
            const rows=db.prepare('SELECT cursor, payload FROM envelopes WHERE cursor > ? ORDER BY cursor LIMIT 100').all(Number(cursor));
            const nextCursor=rows.length ? String(rows.at(-1).cursor) : cursor;
            return send(response,200,{envelopes:rows.map(r=>JSON.parse(r.payload)),nextCursor,hasMore:db.prepare('SELECT 1 FROM envelopes WHERE cursor > ?').get(Number(nextCursor))!==undefined});
        }
        if(request.method!=='POST') return send(response,405,{error:'request_failed'});
        const chunks=[];let size=0;
        for await(const chunk of request) { size+=chunk.length; if(size>13*1024*1024) throw Error('batch_too_large'); chunks.push(chunk); }
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(url.pathname.endsWith('receipts')) {
            if(!body.frontier || Object.entries(body.frontier).some(([w,n])=>!Object.hasOwn(keys,w) || !Number.isSafeInteger(n) || n<0 || n>(db.prepare('SELECT max(sequence) AS n FROM envelopes WHERE writer = ?').get(w).n || 0))) throw Error('frontier_ahead');
            db.prepare('INSERT OR REPLACE INTO receipts VALUES (?, ?)').run(writer,JSON.stringify(body.frontier));
            return send(response,200,{accepted:true});
        }
        if(!Array.isArray(body.envelopes) || !body.envelopes.length || body.envelopes.length>256) fail();
        body.envelopes.forEach(e=>verify(e,writer));
        db.transaction(()=>{
            for(const e of body.envelopes) {
                const payload=JSON.stringify(e),old=db.prepare('SELECT payload FROM envelopes WHERE writer = ? AND sequence = ?').get(writer,e.sequence);
                if(old) { if(old.payload!==payload) throw Error('identity_reused'); continue; }
                const last=db.prepare('SELECT max(sequence) AS n FROM envelopes WHERE writer = ?').get(writer).n || 0;
                if(e.sequence!==last+1) throw Error('sequence_gap');
                db.prepare('INSERT INTO envelopes(writer,sequence,payload) VALUES (?, ?, ?)').run(writer,e.sequence,payload);
            }
        })();
        send(response,200,{storedThrough:body.envelopes.at(-1).sequence});
    } catch(error) { send(response,400,{error:['invalid_envelope','batch_too_large','frontier_ahead','identity_reused','sequence_gap'].includes(error.message)?error.message:'request_failed'}); }
});
server.listen(0,'127.0.0.1',()=>process.stdout.write(`http://127.0.0.1:${server.address().port}\n`));
process.once('SIGTERM',()=>{
    server.close(()=>{db.close();fs.rmSync(folder,{recursive:true,force:true});process.exit(0);});
    server.closeAllConnections();
});
