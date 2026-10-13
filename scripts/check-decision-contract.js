#!/usr/bin/env node
'use strict';
// Run before releasing either repository; native bundle freshness is checked
// separately by build-shared-core.js --check.
const fs = require('node:fs'), path = require('node:path');
const source = path.resolve(__dirname, '../js/shared/decision-contract.js');
const connect = path.resolve(process.argv[2] || path.resolve(__dirname, '../../anjadhe-connect'));
const copy = path.join(connect, 'lib/decision-contract.js');
if (!fs.existsSync(copy) || !fs.readFileSync(source).equals(fs.readFileSync(copy))) {
    console.error('Connect decision contract differs from the canonical app source. Sync the contract before release.');
    process.exitCode = 1;
} else console.log('Connect decision contract matches the canonical shared source.');
