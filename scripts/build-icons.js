#!/usr/bin/env node
/**
 * Build every app-icon asset from one vector mark.
 *
 *   npm run build:icons
 *
 * The mark (2026-09-02, replaced the turbaned-face drawing) is a bold
 * rounded-stroke white "A" on a dark grey tile — monochrome like the
 * Minimal Book theme, nothing cultural or figurative, quiet enough to sit
 * in a Dock without shouting. The geometry lives
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
// Subtle by request: a white glyph on dark grey (not black), no edge line.
const GLYPH = '#ffffff', TILE = '#3a3a3a';

// ── The mark ────────────────────────────────────────────────────────────
// Designed on an 824px tile centred at (512,512); `scale` grows it around
// the centre for the full-bleed iOS icon and the bare launch glyph.
function glyph(color, sw, scale = 1) {
    const p = (x, y) => [512 + (x - 512) * scale, 512 + (y - 512) * scale - 8 * scale];
    const [ax, ay] = p(512, 302), [lx, ly] = p(322, 722), [rx, ry] = p(702, 722);
    const [b1x, b1y] = p(396, 590), [b2x, b2y] = p(628, 590);
    const d = `M${lx} ${ly} L${ax} ${ay} L${rx} ${ry} M${b1x} ${b1y} L${b2x} ${b2y}`;
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${(sw * scale).toFixed(1)}"`
        + ' stroke-linecap="round" stroke-linejoin="round"/>';
}
const tile = () => `<rect x="100" y="100" width="824" height="824" rx="186" fill="${TILE}"/>`;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${body}</svg>\n`;

const MAC = svg(tile() + glyph(GLYPH, 88));
const IOS = svg(`<rect width="${S}" height="${S}" fill="${TILE}"/>` + glyph(GLYPH, 88, 1024 / 824));
// The launch screen is white, so the launch asset is the whole tile (a bare
// white glyph would vanish), scaled to fill the canvas like the iOS icon.
const LAUNCH = svg(`<rect width="${S}" height="${S}" rx="231" fill="${TILE}"/>` + glyph(GLYPH, 88, 1024 / 824));

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
