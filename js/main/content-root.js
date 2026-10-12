/**
 * The user-content folder: ~/nenva (Markdown documents, the Documents
 * library). Under ANJADHE_DATA_ROOT it lives inside the test root instead,
 * never in the real home folder.
 *
 * OLD_NAME is the name builds before 2026-09-30 used; only the erase reads
 * it, to take a link an old build left under that name with the folder.
 */
'use strict';
const os = require('os');
const path = require('path');

const NEW_NAME = 'nenva';
const OLD_NAME = 'Anjadhe';

function _base() {
    return process.env.ANJADHE_DATA_ROOT ? path.resolve(process.env.ANJADHE_DATA_ROOT) : os.homedir();
}

/** The content root. */
function resolveRoot() { return path.join(_base(), NEW_NAME); }

module.exports = { resolveRoot, NEW_NAME, OLD_NAME };
