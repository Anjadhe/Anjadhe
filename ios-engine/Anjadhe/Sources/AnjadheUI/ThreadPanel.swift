import SwiftUI
import Charts
import AnjadheCore

/// Supporting pictures, drawn only from the shared read-only projection.
/// Presenting this sheet has no model, provider or persistence side effect.
struct ThreadPanelView: View {
    let id: String
    @EnvironmentObject private var threads: ThreadStore
    @EnvironmentObject private var router: Router
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScreenColumn(spacing: 18) {
                if let row = threads.thread(id) {
                    ScreenHead(row["title"]?.stringValue ?? "Thread", sub: "What you’re tracking")
                    if let error = threads.error { EmptyText(error) }
                    let blocks = row["panel"]?.arrayValue ?? []
                    if blocks.isEmpty { EmptyText("No figures, dated items or amounts are saved here yet.") }
                    ForEach(blocks, id: \.recordID) { entry in
                        PanelBlockView(entry: entry) { link in
                            if router.openRecordLink(link) { dismiss() }
                        }
                    }
                    Text("From records saved on this iPhone.").font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                    if let by = row["arrangedBy"]?.stringValue {
                        Text(by == "the person" ? "Arranged the way you asked." : "Arranged by nenva.")
                            .font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                    }
                } else { EmptyText("This thread is no longer available.") }
            }.pushedScreen().toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }.frame(minHeight: 44)
                }
            }
        }.tint(Theme.text)
    }
}

private struct PanelBlockView: View {
    let entry: JSONValue
    var open: (String) -> Void
    private var block: JSONValue { entry["block"] ?? .null }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(block["title"]?.stringValue ?? block["label"]?.stringValue ?? entry["label"]?.stringValue ?? "Tracking")
                .font(.title3.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            switch block["kind"]?.stringValue {
            case "stats": stats
            case "line": PanelLineView(block: block)
            case "bar": PanelBarView(block: block)
            case "days": PanelDaysView(block: block)
            case "table": table
            default: EmptyText("This view needs a newer app version.")
            }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface).clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
    }
    private var stats: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array((block["items"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(item["label"]?.stringValue ?? "").font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                    Text(item["display"]?.stringValue ?? "").font(.title2.weight(.semibold)).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    if let sub = item["sub"]?.stringValue { Text(sub).font(Theme.detailFont).foregroundStyle(Theme.textSecondary) }
                }.accessibilityElement(children: .combine)
            }
        }
    }
    private var table: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array((block["rows"]?.arrayValue ?? []).enumerated()), id: \.offset) { index, row in
                if index > 0 { Divider().padding(.vertical, 12) }
                if let link = row["_link"]?.stringValue, URL(string: link)?.scheme == "anjadhe" {
                    Button { open(link) } label: { PanelTableRow(row: row, linked: true) }
                        .buttonStyle(.plain).accessibilityHint("Opens its thread")
                } else { PanelTableRow(row: row, linked: false).textSelection(.enabled) }
            }
        }
    }
}

/// Tables become vertical record summaries on a phone, with no sideways prose.
private struct PanelTableRow: View {
    let row: JSONValue
    let linked: Bool
    @Environment(\.dynamicTypeSize) private var typeSize
    private var cells: [JSONValue] { row["cells"]?.arrayValue ?? [] }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Text(cells.first?["display"]?.stringValue ?? "Item").font(Theme.rowFont)
                    .foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
                if linked { Spacer(minLength: 6); Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.textSecondary).accessibilityHidden(true) }
            }
            ForEach(Array(cells.dropFirst().enumerated()), id: \.offset) { _, cell in
                let layout = typeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
                    : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
                layout {
                    Text(cell["label"]?.stringValue ?? "").font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                    if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                    Text(cell["display"]?.stringValue ?? "").font(Theme.bodyFont).foregroundStyle(Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            .accessibilityElement(children: .combine)
    }
}

private struct PanelLineView: View {
    let block: JSONValue
    private var points: [JSONValue] { block["points"]?.arrayValue ?? [] }
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let last = points.last {
                Text(last["display"]?.stringValue ?? "").font(.title2.weight(.semibold)).textSelection(.enabled)
            }
            Chart(Array(points.enumerated()), id: \.offset) { _, point in
                if let value = point["y"]?.numberValue {
                    LineMark(x: .value("Day", point["x"]?.stringValue ?? ""), y: .value("Value", value))
                        .foregroundStyle(Theme.text)
                    PointMark(x: .value("Day", point["x"]?.stringValue ?? ""), y: .value("Value", value))
                        .foregroundStyle(Theme.text).symbolSize(14)
                }
            }.chartYAxis(.hidden).frame(height: typeSize.isAccessibilitySize ? 220 : 160)
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) { axis in
                        AxisValueLabel {
                            if let day = axis.as(String.self) {
                                Text(points.first { $0["x"]?.stringValue == day }?["dateLabel"]?.stringValue ?? day)
                            }
                        }
                    }
                }
                .accessibilityHidden(true)
            DisclosureGroup {
                ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                    PanelValueRow(label: point["dateLabel"]?.stringValue ?? "", value: point["display"]?.stringValue ?? "")
                }
            } label: { Text("Values").font(Theme.bodyFont).frame(minHeight: 44) }
        }
    }
}

private struct PanelBarView: View {
    let block: JSONValue
    private var items: [JSONValue] { block["items"]?.arrayValue ?? [] }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Chart(Array(items.enumerated()), id: \.offset) { _, item in
                if let value = item["value"]?.numberValue {
                    BarMark(x: .value("Amount", value), y: .value("Month", item["label"]?.stringValue ?? ""))
                        .foregroundStyle(Theme.text)
                }
            }.chartXAxis(.hidden).frame(height: CGFloat(max(120, items.count * 38))).accessibilityHidden(true)
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                PanelValueRow(label: item["label"]?.stringValue ?? "", value: item["display"]?.stringValue ?? "")
            }
        }
    }
}

private struct PanelValueRow: View {
    let label: String
    let value: String
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        layout {
            Text(label).font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
            if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
            Text(value).font(Theme.bodyFont).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }.padding(.vertical, 4).accessibilityElement(children: .combine)
    }
}

private struct PanelDaysView: View {
    let block: JSONValue
    @Environment(\.dynamicTypeSize) private var typeSize
    private var days: [JSONValue] { block["days"]?.arrayValue ?? [] }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(block["summary"]?.stringValue ?? "").font(Theme.bodyFont).fixedSize(horizontal: false, vertical: true)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: typeSize.isAccessibilitySize ? 4 : 7), spacing: 8) {
                ForEach(days, id: \.agendaDate) { day in
                    Image(systemName: symbol(day["state"]?.stringValue ?? "open"))
                        .font(.system(size: 16)).frame(maxWidth: .infinity).frame(height: 32)
                        .foregroundStyle(Theme.text).background(Theme.bg, in: RoundedRectangle(cornerRadius: 4))
                        .accessibilityLabel((day["dateLabel"]?.stringValue ?? "") + ", " + (day["stateLabel"]?.stringValue ?? ""))
                }
            }
            if let first = days.first?["dateLabel"]?.stringValue, let last = days.last?["dateLabel"]?.stringValue {
                Text("\(first) to \(last)").font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: typeSize.isAccessibilitySize ? 1 : 2), spacing: 10) {
                Label("Done", systemImage: "checkmark")
                Label("Skipped", systemImage: "minus")
                Label("Not marked", systemImage: "circle.dotted")
                Label("Not yet", systemImage: "circle")
            }.font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
            DisclosureGroup {
                ForEach(days, id: \.agendaDate) { day in
                    PanelValueRow(label: day["dateLabel"]?.stringValue ?? "", value: day["stateLabel"]?.stringValue ?? "")
                }
            } label: { Text("Days").font(Theme.bodyFont).frame(minHeight: 44) }
        }
    }
    private func symbol(_ state: String) -> String {
        switch state {
        case "done": return "checkmark"
        case "skipped": return "minus"
        case "missed": return "circle.dotted"
        default: return "circle"
        }
    }
}
