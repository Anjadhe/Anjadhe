#!/usr/bin/env node
/*
 * Generate the demo videos' background music — a quiet, professional
 * ambient bed (warm pad progression, sparse piano, soft sub bass) that
 * sits under the baked-in captions without competing for attention.
 * Pure Node, no dependencies; deterministic (seeded), so every render is
 * the same track.
 *
 *   node scripts/demo-music.mjs [outfile.wav] [minutes]
 *   ffmpeg -i demo-music.wav -c:a aac -b:a 192k demo-music.m4a
 *
 * Mux under a demo (fade in 3s, fade out over the last 6s):
 *   DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 demo.mp4)
 *   ffmpeg -i demo.mp4 -stream_loop -1 -i demo-music.m4a -filter_complex \
 *     "[1:a]afade=t=in:d=3,afade=t=out:st=$(echo "$DUR-6"|bc):d=6,volume=0.9[a]" \
 *     -map 0:v -map "[a]" -c:v copy -c:a aac -shortest demo-with-music.mp4
 */
import fs from 'node:fs';

const OUT = process.argv[2] || 'demo-music.wav';
const MINUTES = Number(process.argv[3] || 6);
const SR = 44100;
const DUR = Math.round(MINUTES * 60);
const N = SR * DUR;

// Seeded RNG — same track every render.
let seed = 20260822;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ── The harmony ─────────────────────────────────────────────────────────
// Cmaj9 → Am9 → Fmaj9 → G6/9, 13s per chord (~52s cycle). Warm, familiar,
// resolves gently — corporate-ambient without being elevator music.
const CHORDS = [
    { bass: 36, pad: [48, 52, 55, 59, 62], color: [76, 79, 83] },   // C2 | C3 E3 G3 B3 D4
    { bass: 33, pad: [45, 48, 52, 55, 59], color: [72, 76, 79] },   // A1 | A2 C3 E3 G3 B3
    { bass: 41, pad: [53, 57, 60, 64, 67], color: [77, 81, 84] },   // F2 | F3 A3 C4 E4 G4
    { bass: 43, pad: [43, 47, 50, 52, 57], color: [74, 79, 83] },   // G2 | G2 B2 D3 E3 A3
];
const CHORD_SEC = 13;
const XFADE = 3.0;

const L = new Float64Array(N);
const R = new Float64Array(N);

// ── Pads: detuned sine pairs per note, slow crossfades between chords ───
console.log('pads…');
{
    const lfoRate = 0.09, lfoDepth = 0.13;
    for (let start = 0, ci = 0; start < DUR; start += CHORD_SEC, ci++) {
        const chord = CHORDS[ci % CHORDS.length];
        const s0 = Math.max(0, Math.round((start - XFADE / 2) * SR));
        const s1 = Math.min(N, Math.round((start + CHORD_SEC + XFADE / 2) * SR));
        const segN = s1 - s0;
        for (const m of chord.pad) {
            const f = midi(m);
            const det = 1 + (rand() - 0.5) * 0.003;      // ±~2.5 cents
            const phL = rand() * Math.PI * 2, phR = rand() * Math.PI * 2;
            const amp = 0.16 / chord.pad.length;
            for (let i = 0; i < segN; i++) {
                const t = (s0 + i) / SR;
                const x = i / segN;
                // raised-cosine window over the whole segment = crossfade
                const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * Math.min(Math.max(x, 0), 1));
                const lfo = 1 + lfoDepth * Math.sin(2 * Math.PI * lfoRate * t + phL);
                const a = amp * env * lfo;
                L[s0 + i] += a * Math.sin(2 * Math.PI * f * det * t + phL);
                R[s0 + i] += a * Math.sin(2 * Math.PI * f / det * t + phR);
            }
        }
    }
}

// ── Sub bass: one soft sine per chord, slow swell ───────────────────────
console.log('bass…');
{
    for (let start = 0, ci = 0; start < DUR; start += CHORD_SEC, ci++) {
        const f = midi(CHORDS[ci % CHORDS.length].bass);
        const s0 = Math.round(start * SR);
        const s1 = Math.min(N, Math.round((start + CHORD_SEC) * SR));
        const segN = s1 - s0;
        for (let i = 0; i < segN; i++) {
            const t = (s0 + i) / SR;
            const x = i / segN;
            const env = Math.min(x / 0.18, 1) * Math.min((1 - x) / 0.22, 1);
            const a = 0.10 * Math.max(env, 0);
            const v = a * Math.sin(2 * Math.PI * f * t);
            L[s0 + i] += v; R[s0 + i] += v;
        }
    }
}

// ── Piano: sparse plucked chord tones with a ping-pong echo ─────────────
console.log('piano…');
{
    const piano = { l: new Float64Array(N), r: new Float64Array(N) };
    const pluck = (f, at, vel, pan) => {
        const s0 = Math.round(at * SR);
        const len = Math.min(Math.round(3.2 * SR), N - s0);
        if (len <= 0) return;
        const gl = vel * (0.5 - pan / 2), gr = vel * (0.5 + pan / 2);
        for (let p = 1; p <= 6; p++) {
            const pf = f * p * (1 + 0.0004 * p * p);      // slight inharmonicity
            if (pf > 9000) break;
            const pa = 1 / Math.pow(p, 1.6);
            const tau = 1.15 / Math.pow(p, 0.7);
            const ph = rand() * Math.PI * 2;
            for (let i = 0; i < len; i++) {
                const t = i / SR;
                const env = Math.min(t / 0.004, 1) * Math.exp(-t / tau);
                const v = pa * env * Math.sin(2 * Math.PI * pf * t + ph);
                piano.l[s0 + i] += gl * v;
                piano.r[s0 + i] += gr * v;
            }
        }
    };
    // 2–4 quiet notes per chord, on a gentle grid, from the chord's colour
    // tones; the first cycle stays sparser (the track opens with the fade).
    for (let start = 0, ci = 0; start < DUR - 4; start += CHORD_SEC, ci++) {
        const chord = CHORDS[ci % CHORDS.length];
        const count = ci === 0 ? 2 : 2 + Math.floor(rand() * 3);
        const slots = [1.2, 4.4, 6.8, 9.2, 11.4];
        const used = new Set();
        for (let k = 0; k < count; k++) {
            let si; do { si = Math.floor(rand() * slots.length); } while (used.has(si));
            used.add(si);
            const note = chord.color[Math.floor(rand() * chord.color.length)];
            const oct = rand() < 0.22 ? 12 : 0;
            pluck(midi(note + oct), start + slots[si] + rand() * 0.25,
                0.10 + rand() * 0.05, (rand() - 0.5) * 0.9);
        }
    }
    // Ping-pong echo, dotted-ish delay.
    const d = Math.round(0.42 * SR), fb = 0.34;
    for (let i = d; i < N; i++) {
        piano.l[i] += fb * piano.r[i - d];
        piano.r[i] += fb * piano.l[i - d];
    }
    for (let i = 0; i < N; i++) { L[i] += piano.l[i]; R[i] += piano.r[i]; }
}

// ── Air: very quiet, slowly breathing filtered noise ────────────────────
console.log('air…');
{
    let lpL = 0, lpR = 0;
    for (let i = 0; i < N; i++) {
        const t = i / SR;
        const breathe = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.05 * t);
        const k = 0.02;                                    // ~140Hz-ish lowpass on noise → rumble-free hush
        lpL += k * ((rand() * 2 - 1) - lpL);
        lpR += k * ((rand() * 2 - 1) - lpR);
        L[i] += 0.010 * breathe * lpL;
        R[i] += 0.010 * breathe * lpR;
    }
}

// ── Master: intro/outro fades, gentle saturation, normalize ─────────────
console.log('master…');
{
    const fin = 4 * SR, fout = 8 * SR;
    for (let i = 0; i < N; i++) {
        let g = 1;
        if (i < fin) g = i / fin;
        if (i > N - fout) g = Math.min(g, (N - i) / fout);
        L[i] *= g; R[i] *= g;
    }
    let peak = 0;
    for (let i = 0; i < N; i++) {
        L[i] = Math.tanh(L[i] * 1.15);
        R[i] = Math.tanh(R[i] * 1.15);
        peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    }
    const norm = 0.85 / peak;
    for (let i = 0; i < N; i++) { L[i] *= norm; R[i] *= norm; }
}

// ── 16-bit stereo WAV ───────────────────────────────────────────────────
console.log('write…');
{
    const bytes = N * 4;
    const buf = Buffer.alloc(44 + bytes);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
    buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(bytes, 40);
    for (let i = 0; i < N; i++) {
        buf.writeInt16LE(Math.round(L[i] * 32767), 44 + i * 4);
        buf.writeInt16LE(Math.round(R[i] * 32767), 44 + i * 4 + 2);
    }
    fs.writeFileSync(OUT, buf);
}
console.log(`wrote ${OUT} — ${MINUTES} min, 44.1kHz stereo`);
