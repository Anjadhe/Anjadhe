'use strict';
const net = require('node:net'), crypto = require('node:crypto'), { EventEmitter } = require('node:events');
const { encode, reader } = require('./protocol');
class NativeBridge extends EventEmitter {
    constructor({ extensionId, token = crypto.randomBytes(32).toString('hex') }) {
        super(); this.extensionId = extensionId; this.token = token; this.pending = new Map(); this.clients = new Set();
    }
    async listen() {
        this.server = net.createServer(socket => {
            this.clients.add(socket);
            let authenticated = false;
            const timer = setTimeout(() => socket.destroy(), 3000);
            socket.on('data', reader(message => {
                if (!authenticated) {
                    const supplied = typeof message.token === 'string' ? Buffer.from(message.token) : Buffer.alloc(0);
                    const expected = Buffer.from(this.token);
                    if (this.socket || message.kind !== 'hello' || message.extensionId !== this.extensionId
                        || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return socket.destroy();
                    authenticated = true; clearTimeout(timer); this.socket = socket;
                    socket.write(encode({ kind: 'ready' })); this.emit('connected'); return;
                }
                if (message.kind === 'state') { this.emit('state', message.state); return; }
                if (message.kind !== 'result' || typeof message.id !== 'string') return socket.destroy();
                const pending = this.pending.get(message.id);
                if (!pending) return;
                this.pending.delete(message.id); clearTimeout(pending.timer);
                if (message.error) pending.reject(new Error(String(message.error).slice(0, 300)));
                else pending.resolve(message.value);
            }, () => socket.destroy()));
            socket.on('error', () => {});
            socket.on('close', () => {
                clearTimeout(timer); this.clients.delete(socket);
                if (this.socket !== socket) return;
                this.socket = null; this.rejectPending('Chrome disconnected. Reconnect it, then Continue.');
                this.emit('disconnected');
            });
        });
        await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
        return this.server.address().port;
    }
    request(operation, args = {}, timeout = 20000) {
        if (!this.socket) return Promise.reject(new Error('Chrome is not connected. Open Browser setup and connect the extension.'));
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                // A timed-out action must not stay queued in the extension.
                this.socket?.destroy();
                reject(new Error('Chrome did not finish the action. Check its current page before continuing.'));
            }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            try { this.socket.write(encode({ kind: 'command', id, operation, args })); }
            catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
        });
    }
    rejectPending(message) {
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
        this.pending.clear();
    }
    close() {
        this.rejectPending('Browser connection closed.');
        for (const socket of this.clients) socket.destroy();
        this.server?.close(); this.server = null; this.socket = null;
    }
}
module.exports = NativeBridge;

