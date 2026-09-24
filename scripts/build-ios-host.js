#!/usr/bin/env node
/**
 * build-ios-host.js — assemble the iPhone app's SYNC HOST web assets into
 * ios/App/App/public (bundled into the app as the `public` folder resource).
 *
 * The iPhone app is native SwiftUI (ios-engine/Anjadhe + ios/App). Its sync,
 * pairing and assistant channel still run the proven JS Noise stack inside a
 * hidden WKWebView (AnjadheUI.SyncCoordinator, docs/MOBILE_NATIVE.md) — this
 * script builds exactly what that host page loads:
 *
 *   1. the data + channel adapters — native-bridge.js (backs storage with the
 *      native KVStore), mobile-pairing.js, mobile-sync.js
 *   2. the secure channel bundle  — esbuild bundles the ESM channel +
 *      @noble crypto into one classic script
 *
 * Run:  npm run build:ios-host   (then build the Xcode project)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'ios', 'App', 'App', 'public');

const HOST_FILES = [
  'js/adapter/native-bridge.js',
  'js/adapter/mobile-pairing.js',
  'js/adapter/mobile-sync.js',
];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const rel of HOST_FILES) {
  const dst = path.join(out, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(root, rel), dst);
}

require('esbuild').buildSync({
  entryPoints: [path.join(root, 'js', 'channel', 'mobile-channel.mjs')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: path.join(out, 'js', 'channel', 'channel.bundle.js'),
});

console.log('build-ios-host: wrote ' + path.relative(root, out) + '/');
