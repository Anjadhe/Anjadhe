'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const name of ['js/adapter', 'js/channel', 'relay', 'js/agent/mobile-channel.js', 'js/agent/mobile-views.js',
    'scripts/build-ios-host.js', 'ios/App/App/public', 'ios-engine/Anjadhe/Sources/AnjadheUI/SyncCoordinator.swift',
    'ios-engine/Anjadhe/Sources/AnjadheUI/PhoneAgent.swift']) assert.equal(fs.existsSync(path.join(root, name)), false, name);
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
for (const file of ['main.js', 'preload.js', 'index.html', 'js/core/app-manager.js', 'js/apps/settings/settings-app.js', 'js/agent/agent-service.js']) {
    assert.doesNotMatch(read(file), /electronChannel|electronMobileChat|electronMobileViews|MobileChannel|MobileViews|channel-ensure|channel-begin-pairing/, file);
}
assert.doesNotMatch(read('ios/App/App.xcodeproj/project.pbxproj'), /public in Resources/);
assert.doesNotMatch(read('ios/App/App/Info.plist'), /NSLocalNetworkUsageDescription|NSAllowsLocalNetworking/);
assert.equal(JSON.parse(read('package.json')).scripts['build:ios-host'], undefined);
assert.equal(JSON.parse(read('remote-config.json')).featureFlags.mobilesync, undefined);
console.log('Mobile retirement: no v1 app transport, executor, bridge or bundled host remains');
