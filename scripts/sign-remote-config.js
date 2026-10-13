#!/usr/bin/env node
/**
 * Sign remote-config.json in place (js/main/remote-config-signature.js RC3).
 * The private key lives outside the repo: $NENVA_REMOTE_CONFIG_KEY, or
 * ~/.nenva_signing/remote-config-ed25519.pem. Run after every edit to the
 * file; `--check` only verifies and exits non-zero when it does not.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const RCS = require('../js/main/remote-config-signature');

const file = path.join(__dirname, '..', 'remote-config.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));

if (process.argv.includes('--check')) {
    if (RCS.verify(config)) { console.log('remote-config.json: signature ok'); process.exit(0); }
    console.error('remote-config.json: signature missing or does not match. Run: node scripts/sign-remote-config.js');
    process.exit(1);
}

const keyPath = process.env.NENVA_REMOTE_CONFIG_KEY || path.join(os.homedir(), '.nenva_signing', 'remote-config-ed25519.pem');
if (!fs.existsSync(keyPath)) {
    console.error(`No signing key at ${keyPath}. Set NENVA_REMOTE_CONFIG_KEY to its path.`);
    process.exit(1);
}
const signed = RCS.sign(config, fs.readFileSync(keyPath, 'utf8'));
if (!RCS.verify(signed)) {
    console.error('The key does not match the public key in js/main/remote-config-signature.js.');
    process.exit(1);
}
// Text-level, so the file keeps its hand formatting: drop an old signature
// line, then add the new one as the last field.
let text = fs.readFileSync(file, 'utf8').replace(/,\s*"signature":\s*\{[^{}]*\}\s*\}\s*$/, '\n}');
text = text.replace(/\s*\}\s*$/, `,\n  "signature": ${JSON.stringify(signed.signature).replace(/,/g, ', ').replace(/:/g, ': ')}\n}\n`);
if (!RCS.verify(JSON.parse(text))) { console.error('Signing failed: the rewritten file does not verify.'); process.exit(1); }
fs.writeFileSync(file, text);
console.log('remote-config.json signed');
