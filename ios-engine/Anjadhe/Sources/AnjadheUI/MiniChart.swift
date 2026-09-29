import SwiftUI

// A small line chart, drawn by hand (2026-09-21).
//
// Hand-drawn rather than Swift Charts on purpose: the theme's law is ink,
// hairlines and ONE accent, and Charts arrives with its own axes, gridlines,
// legend and colour opinions that would then have to be argued down one
// modifier at a time. A `Path` over a `GeometryReader` is forty lines and
// obeys the theme by construction.
//
// Colour follows the app's rule: a series that carries a SIGN (a portfolio's
// value over a range, a ticker's price over a range) is drawn in the semantic
// red/green of its own direction — the same sanctioned exception the money
// numbers make — and everything else is ink. The fill is the line's colour at
// a whisper, never a block.

/// One series. `values` are plotted in order; `labels` is only for the ends.
struct MiniChart: View {
    let values: [Double]
    var height: CGFloat = 132
    /// nil = ink. Otherwise the line takes the sign of (last − first).
    var signed: Bool = true
    var accent: Color? = nil

    private var tone: Color {
        if let a = accent { return a }
        guard signed, let f = values.first, let l = values.last else { return Theme.text }
        if l > f { return Theme.success }
        if l < f { return Theme.danger }
        return Theme.text
    }

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let pts = points(in: CGSize(width: w, height: h))
            ZStack {
                if pts.count > 1 {
                    // The wash under the line. Clipped to the same path plus
                    // the baseline, so it never reads as a second series.
                    Path { p in
                        p.move(to: CGPoint(x: pts[0].x, y: h))
                        for pt in pts { p.addLine(to: pt) }
                        p.addLine(to: CGPoint(x: pts[pts.count - 1].x, y: h))
                        p.closeSubpath()
                    }
                    .fill(LinearGradient(colors: [tone.opacity(0.14), tone.opacity(0.0)],
                                         startPoint: .top, endPoint: .bottom))

                    Path { p in
                        p.move(to: pts[0])
                        for pt in pts.dropFirst() { p.addLine(to: pt) }
                    }
                    .stroke(tone, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
                }
            }
        }
        .frame(height: height)
    }

    private func points(in size: CGSize) -> [CGPoint] {
        guard values.count > 1 else { return [] }
        let lo = values.min() ?? 0
        let hi = values.max() ?? 0
        // A flat series would divide by zero; draw it down the middle.
        let span = (hi - lo) == 0 ? 1 : (hi - lo)
        let pad: CGFloat = 3
        let usable = max(1, size.height - pad * 2)
        return values.enumerated().map { i, v in
            let x = size.width * CGFloat(i) / CGFloat(values.count - 1)
            let y = pad + usable * CGFloat(1 - (v - lo) / span)
            return CGPoint(x: x, y: (hi - lo) == 0 ? size.height / 2 : y)
        }
    }
}

/// The chart with the range pills the desktop puts over it, and the honest
/// empty state when there is not yet enough history to draw a line.
struct RangedChart: View {
    let values: [Double]
    let ranges: [(id: String, label: String)]
    @Binding var range: String
    var signed: Bool = true
    var accent: Color? = nil
    var emptyText: String = "Not enough history yet to draw a line."

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if ranges.count > 1 {
                HStack(spacing: 6) {
                    ForEach(ranges, id: \.id) { r in
                        Button { range = r.id } label: {
                            Text(r.label)
                                .font(.system(size: 12, weight: range == r.id ? .semibold : .regular))
                                .foregroundStyle(range == r.id ? Theme.bg : Theme.textSecondary)
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background(Capsule().fill(range == r.id ? Theme.text : Theme.surface))
                                .overlay(Capsule().strokeBorder(range == r.id ? Theme.text : Theme.border))
                        }
                        .buttonStyle(.plain)
                    }
                    Spacer()
                }
            }
            if values.count > 1 {
                MiniChart(values: values, signed: signed, accent: accent)
            } else {
                Text(emptyText)
                    .font(.system(size: 13)).italic()
                    .foregroundStyle(Theme.textTertiary)
                    .frame(height: 60)
            }
        }
    }
}

/// The masthead's composition bar: one segment per asset class, drawn at the
/// weights the Mac computed. Colour here is DATA (the desktop's fourth
/// sanctioned exception — three shades of ink were indistinguishable at 6px),
/// and the legend text stays ink.
struct CompositionBar: View {
    /// `(label, value, hue)` — hue nil falls back to ink at a step.
    let parts: [(String, Double, Color)]

    private var total: Double { parts.reduce(0) { $0 + max(0, $1.1) } }

    var body: some View {
        if parts.count > 1, total > 0 {
            VStack(alignment: .leading, spacing: 8) {
                GeometryReader { geo in
                    HStack(spacing: 2) {
                        ForEach(Array(parts.enumerated()), id: \.offset) { _, p in
                            Rectangle()
                                .fill(p.2)
                                .frame(width: max(2, geo.size.width * CGFloat(max(0, p.1) / total)))
                        }
                    }
                    .clipShape(Capsule())
                }
                .frame(height: 6)

                HStack(spacing: 14) {
                    ForEach(Array(parts.enumerated()), id: \.offset) { _, p in
                        HStack(spacing: 5) {
                            Circle().fill(p.2).frame(width: 7, height: 7)
                            Text(p.0).font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }
}
