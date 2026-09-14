#!/usr/bin/env node
/**
 * Build every app-icon asset from one vector mark.
 *
 *   npm run build:icons
 *
 * The mark (2026-09-11, by request: "consistent with the new font design,
 * remove the blue") is the app's own display face: a white serif "A" set
 * in Charter (the theme's heading face since 2026-09-11 — core.css
 * `--font-serif`, with the same fallbacks) on a near-black tile with a
 * soft vertical gradient and a faint sheen at the top. No dot, no colour
 * anywhere: the theme keeps its one blue for what is live, and the icon
 * is not live. It replaced the shelter A with the indigo dot of
 * 2026-09-10, which replaced the plain white "A" of 2026-09-02, which
 * replaced the turbaned-face drawing. Still nothing cultural or
 * figurative, still one glyph, still quiet in a Dock. The geometry lives
 * HERE; build/icon.svg is written from it and is the reviewable source.
 *
 * Outputs:
 *   build/icon.svg                                   vector source (macOS tile)
 *   build/icon.png                                   1024, transparent margin,
 *                                                    824px squircle (Apple's
 *                                                    macOS icon grid); in-app it
 *                                                    appears ONLY on the initial
 *                                                    loader (by request, 2026-09-02)
 *   build/icon.icns                                  macOS bundle icon
 *   build/icon-120.png                               small copy
 *   ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
 *                                                    1024 full-bleed, RGB (iOS
 *                                                    rejects an alpha channel;
 *                                                    iOS applies its own mask)
 *   ios/App/App/Assets.xcassets/LaunchLogo.imageset/launch-logo.png
 *   ios-engine/Anjadhe/Sources/AnjadheUI/Resources/launch-logo.png
 *                                                    the tile, full-bleed rounded,
 *                                                    on transparent (the launch
 *                                                    screen is white)
 *
 * Rendering: QuickLook flattens SVG transparency, and there is no
 * ImageMagick/rsvg here, so the script re-launches itself under the repo's
 * Electron to rasterise (offscreen window, capturePage). sips + iconutil do
 * the resizing and the .icns; pngjs strips alpha for the iOS icon.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const S = 1024;
// White glyph on the theme's ink (core.css --color-text #171717), lifted a
// step at the top of the gradient. Warm-neutral, never navy, never blue.
const GLYPH = '#ffffff', TILE_TOP = '#2c2c2a', TILE_BOTTOM = '#171717';
// The theme's serif stack, in the order core.css names it.
const FACE = "Charter, 'Iowan Old Style', 'Source Serif Pro', Palatino, Georgia, serif";

// ── The mark ────────────────────────────────────────────────────────────
// Designed on an 824px tile centred at (512,512); `scale` grows it around
// the centre for the full-bleed iOS icon and the bare launch glyph.
const DEFS = `<defs>`
    + `<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${TILE_TOP}"/><stop offset="1" stop-color="${TILE_BOTTOM}"/></linearGradient>`
    + `<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.09"/><stop offset="0.45" stop-color="#fff" stop-opacity="0"/></linearGradient>`
    + `</defs>`;
// One serif capital, optically centred on the tile: Charter's cap height is
// ~0.70 em, so the baseline sits half a cap below centre (nudged 8px up so
// the letter's visual mass, not its box, is centred). `size` is the em
// size on the macOS tile; `scale` refits it to a full-bleed frame.
function glyph(size, scale = 1) {
    const em = size * scale;
    const baseline = 512 + em * 0.70 / 2 - 8 * scale;
    return `<text x="512" y="${baseline.toFixed(1)}" text-anchor="middle" font-family="${FACE}" font-weight="700"`
        + ` font-size="${em.toFixed(1)}" fill="${GLYPH}">A</text>`;
}
// The tile is the gradient plus a top sheen, in whatever frame the asset needs.
const tile = (x, y, w, rx) => `<rect x="${x}" y="${y}" width="${w}" height="${w}" rx="${rx}" fill="url(#tile)"/>`
    + `<rect x="${x}" y="${y}" width="${w}" height="${w}" rx="${rx}" fill="url(#sheen)"/>`;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${DEFS}${body}</svg>\n`;

const MAC = svg(tile(100, 100, 824, 186) + glyph(600));
const IOS = svg(tile(0, 0, S, 0) + glyph(600, 1024 / 824));
// The launch screen is white, so the launch asset is the whole tile (a bare
// white glyph would vanish), scaled to fill the canvas like the iOS icon.
const LAUNCH = svg(tile(0, 0, S, 231) + glyph(600, 1024 / 824));

// ── Electron renderer (this file re-run under electron) ─────────────────
if (process.argv[2] === '--render') {
    const { app, BrowserWindow } = require('electron');
    const [svgPath, outPath] = process.argv.slice(3);
    app.whenReady().then(async () => {
        const win = new BrowserWindow({ width: S, height: S, show: false, transparent: true, frame: false,
            webPreferences: { offscreen: true } });
        const html = `<html><body style="margin:0;background:transparent">${fs.readFileSync(svgPath, 'utf8')}</body></html>`;
        await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        await new Promise((r) => setTimeout(r, 300));
        const img = await win.webContents.capturePage({ x: 0, y: 0, width: S, height: S });
        fs.writeFileSync(outPath, img.toPNG()); // may be 2048² on a Retina display; resized below
        app.quit();
    });
    return;
}

// ── Driver ──────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anjadhe-icons-'));
const electron = path.join(ROOT, 'node_modules', '.bin', 'electron');
if (!fs.existsSync(electron)) { console.error('electron not installed; run npm install'); process.exit(1); }

function render(name, body) {
    const svgPath = path.join(tmp, `${name}.svg`), raw = path.join(tmp, `${name}-raw.png`), out = path.join(tmp, `${name}.png`);
    fs.writeFileSync(svgPath, body);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(electron, [__filename, '--render', svgPath, raw], { env, stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0 || !fs.existsSync(raw)) throw new Error(`render failed for ${name}`);
    execFileSync('sips', ['-z', String(S), String(S), raw, '--out', out], { stdio: 'ignore' });
    return out;
}
function resize(src, size, out) { execFileSync('sips', ['-z', String(size), String(size), src, '--out', out], { stdio: 'ignore' }); }

const mac = render('mac', MAC), ios = render('ios', IOS), launch = render('launch', LAUNCH);

// macOS: png + icns + 120px copy
fs.writeFileSync(path.join(ROOT, 'build/icon.svg'), MAC);
fs.copyFileSync(mac, path.join(ROOT, 'build/icon.png'));
resize(mac, 120, path.join(ROOT, 'build/icon-120.png'));
const iconset = path.join(tmp, 'Anjadhe.iconset'); fs.mkdirSync(iconset);
for (const s of [16, 32, 128, 256, 512]) {
    resize(mac, s, path.join(iconset, `icon_${s}x${s}.png`));
    resize(mac, s * 2, path.join(iconset, `icon_${s}x${s}@2x.png`));
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ROOT, 'build/icon.icns')]);

// iOS: opaque RGB app icon, transparent launch glyph
const { PNG } = require('pngjs');
const rgb = PNG.sync.write(PNG.sync.read(fs.readFileSync(ios)), { colorType: 2 });
fs.writeFileSync(path.join(ROOT, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'), rgb);
for (const dest of ['ios/App/App/Assets.xcassets/LaunchLogo.imageset/launch-logo.png',
    'ios-engine/Anjadhe/Sources/AnjadheUI/Resources/launch-logo.png']) {
    fs.copyFileSync(launch, path.join(ROOT, dest));
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('Icons rebuilt: build/icon.{svg,png,icns,-120.png}, iOS AppIcon + launch-logo.');
