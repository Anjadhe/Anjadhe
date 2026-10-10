/**
 * Globals pdf.js expects before it can be IMPORTED in the main process.
 *
 * pdfjs-dist 6.x evaluates `new DOMMatrix()` at module scope (the canvas
 * renderer's scale matrix) and, on Node, polyfills DOMMatrix/Path2D from
 * the optional `@napi-rs/canvas` package. That package is deliberately
 * excluded from the packaged app (its arm64-only .node file broke the
 * universal build, commit a1fda72), so in the installed app the import
 * itself threw "DOMMatrix is not defined" and every PDF attachment
 * failed — dev runs from source, where node_modules has the package,
 * never saw it.
 *
 * The app only ever calls getTextContent (never renders a page), and no
 * text-extraction path touches DOMMatrix or Path2D; a small 2D-affine
 * DOMMatrix plus an inert Path2D satisfy the import on every install
 * identically. pdf.js only installs its own polyfill when the global is
 * missing, so these are installed first and win in dev too.
 */

class ShimDOMMatrix {
    constructor(init) {
        this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
        if (Array.isArray(init) || (init && typeof init.length === 'number')) {
            if (init.length === 6) {
                [this.a, this.b, this.c, this.d, this.e, this.f] = Array.from(init, Number);
            } else if (init.length === 16) {
                this.a = +init[0]; this.b = +init[1]; this.c = +init[4]; this.d = +init[5]; this.e = +init[12]; this.f = +init[13];
            }
        } else if (init && typeof init === 'object') {
            for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) if (typeof init[k] === 'number') this[k] = init[k];
        }
    }
    get is2D() { return true; }
    get isIdentity() { return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0; }
    get m11() { return this.a; } get m12() { return this.b; } get m21() { return this.c; } get m22() { return this.d; }
    get m41() { return this.e; } get m42() { return this.f; }
    // this × other (other applied first), as the DOM spec defines multiply().
    multiply(o) {
        const m = new ShimDOMMatrix();
        m.a = this.a * o.a + this.c * o.b;
        m.b = this.b * o.a + this.d * o.b;
        m.c = this.a * o.c + this.c * o.d;
        m.d = this.b * o.c + this.d * o.d;
        m.e = this.a * o.e + this.c * o.f + this.e;
        m.f = this.b * o.e + this.d * o.f + this.f;
        return m;
    }
    multiplySelf(o) { return Object.assign(this, this.multiply(o)); }
    preMultiplySelf(o) { return Object.assign(this, new ShimDOMMatrix(o).multiply(this)); }
    translate(tx = 0, ty = 0) { return this.multiply(new ShimDOMMatrix([1, 0, 0, 1, tx, ty])); }
    translateSelf(tx, ty) { return Object.assign(this, this.translate(tx, ty)); }
    scale(sx = 1, sy = sx) { return this.multiply(new ShimDOMMatrix([sx, 0, 0, sy, 0, 0])); }
    scaleSelf(sx, sy) { return Object.assign(this, this.scale(sx, sy)); }
    inverse() { return new ShimDOMMatrix(this).invertSelf(); }
    invertSelf() {
        const det = this.a * this.d - this.b * this.c;
        if (!det) { this.a = this.b = this.c = this.d = this.e = this.f = NaN; return this; }
        const { a, b, c, d, e, f } = this;
        this.a = d / det; this.b = -b / det; this.c = -c / det; this.d = a / det;
        this.e = (c * f - d * e) / det; this.f = (b * e - a * f) / det;
        return this;
    }
    toFloat32Array() { return new Float32Array([this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1]); }
    toFloat64Array() { return new Float64Array(this.toFloat32Array()); }
    toString() { return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`; }
}

class ShimPath2D {
    addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} closePath() {} rect() {} arc() {}
}

function installPdfjsShims() {
    if (typeof globalThis.DOMMatrix === 'undefined') globalThis.DOMMatrix = ShimDOMMatrix;
    if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = ShimPath2D;
}

module.exports = { installPdfjsShims, ShimDOMMatrix };
