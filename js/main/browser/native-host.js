'use strict';
// Native Messaging child: no stores, Electron windows, dotenv, or stdout logs.
const fs = require('node:fs'), net = require('node:net');
const { encode, reader } = require('./protocol');
function run(configPath, origin, { input = process.stdin, output = process.stdout, finish = code => process.exit(code) } = {}) {
    let config;
    try {
        const stat = fs.statSync(configPath);
        if (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid())) throw new Error('Private configuration required');
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (origin !== 'chrome-extension://' + config.extensionId + '/' || !/^[a-p]{32}$/.test(config.extensionId)
            || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid host configuration');
    } catch { finish(1); return; }
    const socket = net.connect({ host: '127.0.0.1', port: config.port });
    let ready = false, done = false;
    const stop = code => { if (done) return; done = true; clearTimeout(timeout); socket.destroy(); finish(code); };
    const timeout = setTimeout(() => stop(1), 5000);
    socket.on('connect', () => socket.write(encode({ kind: 'hello', token: config.token, extensionId: config.extensionId })));
    socket.on('data', reader(message => {
        if (!ready) {
            if (message.kind !== 'ready') return stop(1);
            ready = true; clearTimeout(timeout);
        }
        if (!output.write(encode(message))) socket.pause();
    }, () => stop(1)));
    output.on('drain', () => socket.resume());
    input.on('data', reader(message => {
        if (!ready) return stop(1);
        if (!socket.write(encode(message))) input.pause();
    }, () => stop(1)));
    socket.on('drain', () => input.resume());
    socket.on('error', () => stop(1)); socket.on('close', () => stop(0));
    input.on('end', () => stop(0)); input.on('error', () => stop(1)); output.on('error', () => stop(1));
}
if (require.main === module) run(process.argv[2], process.argv[3]);
module.exports = { run };

