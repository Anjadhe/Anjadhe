#!/usr/bin/env node
/**
 * LlamaCppManager.parseBuild / buildFromUrl — the llama.cpp BUILD number
 * from `llama-server --version` and from the pinned release URL. The
 * automatic engine update compares the two as integers, so returning
 * anything else (the semver llama.cpp added in 0.5.0) would read as build 0
 * and re-download the engine after every launch.
 *
 *   node tests/llamacpp-version-test.js
 */

const M = require('../llamacpp/llamacpp-manager.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const cases = [
    ['old format (b10015 and before)',
        'version: 10015 (8f1e2d3a)\nbuilt with Apple clang version 17.0.0 for arm64-apple-darwin24.0.0', '10015'],
    ['semver format (0.5.0 and after)',
        'version: 0.5.0-dev (build 11301, commit 2149c00f4)\nbuilt with AppleClang 21.0.0.21000101 for Darwin arm64', '11301'],
    ['a b-prefixed build', 'version: b10015 (abc)', '10015'],
    ['"built with" is never read as a build', 'version: 0.6.0\nbuilt with AppleClang 21.0.0', null],
    ['nothing recognisable', 'llama-server: unknown option', null],
    ['empty output', '', null]
];
for (const [name, out, want] of cases) {
    const got = M.parseBuild(out);
    check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// The pin side of the comparison: the build a release URL names.
const urls = [
    ['release URL', 'https://github.com/ggml-org/llama.cpp/releases/download/b11301/llama-b11301-bin-macos-arm64.tar.gz', 11301],
    ['untagged build number', 'https://example.com/download/10015/llama.tar.gz', 10015],
    ['no build in the URL', 'https://example.com/llama.tar.gz', null],
    ['no URL', undefined, null]
];
for (const [name, url, want] of urls) {
    const got = M.buildFromUrl(url);
    check(`pin: ${name}`, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nAll checks passed');
