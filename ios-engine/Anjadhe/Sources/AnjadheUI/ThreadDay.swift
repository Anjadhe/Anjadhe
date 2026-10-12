import SwiftUI
import AnjadheCore

extension JSONValue {
    var threadKey: String { self["key"]?.stringValue ?? "" }
    var recordID: String { self["id"]?.stringValue ?? "" }
    var agendaDate: String { self["date"]?.stringValue ?? "" }
}

/// A Messages-like row; essential titles keep wrapping at accessibility sizes.
struct ThreadListRow: View {
    let row: JSONValue
    @Environment(\.dynamicTypeSize) private var typeSize
    private var unread: Bool { row["unread"]?.boolValue == true }
    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 10) {
                Circle().fill(unread ? Theme.accent : .clear).frame(width: 7, height: 7).padding(.top, 8)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    let layout = typeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 3))
                        : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
                    layout {
                        Text(row["title"]?.stringValue ?? "Thread").font(.body.weight(.semibold))
                            .foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
                        if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                        if let time = row["timeLabel"]?.stringValue, !time.isEmpty {
                            Text(time).font(.caption).foregroundStyle(Theme.textSecondary)
                        }
                    }
                    Text(row["preview"]?.stringValue?.nonEmpty ?? row["facts"]?.stringValue?.nonEmpty ?? "No messages yet.")
                        .font(.subheadline.weight(unread ? .semibold : .regular))
                        .foregroundStyle(Theme.textSecondary).lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.textTertiary).padding(.top, 6)
                    .accessibilityHidden(true)
            }.padding(.vertical, 16).frame(minHeight: 72).contentShape(Rectangle())
            Divider().padding(.leading, 17)
        }.accessibilityElement(children: .combine)
            .accessibilityValue(unread ? "Unread" : "")
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

/// Native disclosures rather than a narrow desktop week strip. All dates,
/// membership and completion decisions arrive from the read-only shared core.
struct ThreadDayView: View {
    let schedule: JSONValue
    @State private var expanded = false
    @State private var more = false
    @State private var upcomingExpanded = false
    private var today: [JSONValue] { schedule["today"]?.arrayValue ?? [] }
    private var overdue: [JSONValue] { schedule["overdue"]?.arrayValue ?? [] }
    private var coming: [JSONValue] { (schedule["coming"]?.arrayValue ?? []).filter { !($0["items"]?.arrayValue ?? []).isEmpty } }
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 16) {
                if today.isEmpty { EmptyText("Nothing scheduled in your saved records today.") }
                else {
                    agenda(more ? today : Array(today.prefix(5)))
                    if today.count > 5 {
                        Button(more ? "Show less" : "\(today.count - 5) more today") { more.toggle() }
                            .font(Theme.actionFont).frame(minHeight: 44)
                    }
                }
                if !overdue.isEmpty {
                    DisclosureGroup {
                        agenda(overdue, showDate: true)
                    } label: { Text("Past due · \(overdue.count)").font(Theme.bodyFont).frame(minHeight: 44) }
                }
                DisclosureGroup(isExpanded: $upcomingExpanded) {
                    if coming.isEmpty { EmptyText("Nothing scheduled in your saved records over the next seven days.") }
                    else {
                        ForEach(coming, id: \.agendaDate) { day in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(dayLabel(day.agendaDate)).font(Theme.detailFont.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                                    .accessibilityAddTraits(.isHeader)
                                agenda(day["items"]?.arrayValue ?? [])
                            }.padding(.vertical, 6)
                        }
                    }
                } label: { Text("Coming up").font(Theme.bodyFont).frame(minHeight: 44) }
                Text("From your saved commitments and events.").font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
            }.padding(.top, 10)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text("Today\(today.isEmpty ? "" : " · \(today.count)")").font(Theme.rowFont)
                Text(today.first?["title"]?.stringValue ?? "Your day, at a glance")
                    .font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }.frame(minHeight: 44, alignment: .leading)
        }.tint(Theme.text).padding(16).background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
            #if DEBUG
            .onAppear {
                if ProcessInfo.processInfo.arguments.contains("--preview-mobile-threads") && ProcessInfo.processInfo.arguments.contains("--preview-mobile-day-expanded") {
                    expanded = true; upcomingExpanded = true
                }
            }
            #endif
    }

    private func agenda(_ rows: [JSONValue], showDate: Bool = false) -> some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(rows, id: \.recordID) { row in AgendaRow(row: row, dateLabel: showDate ? dayLabel(row.agendaDate) : nil) }
        }
    }

    private func dayLabel(_ iso: String) -> String {
        // Interpret date-only values in the local zone, never as UTC midnight.
        let parts = iso.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, let day = Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { return iso }
        return day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }
}

private struct AgendaRow: View {
    let row: JSONValue
    var dateLabel: String?
    @EnvironmentObject private var router: Router
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        Button { router.push(.thread(row.threadKey)) } label: {
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
            layout {
                Text(row["time"]?.stringValue.map(DateLogic.fmtTime) ?? "Anytime")
                    .font(Theme.detailFont).foregroundStyle(Theme.textSecondary)
                    .frame(minWidth: typeSize.isAccessibilitySize ? nil : 76, alignment: .leading)
                VStack(alignment: .leading, spacing: 4) {
                    Text(row["title"]?.stringValue ?? "Commitment").font(Theme.bodyFont)
                        .foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
                    if let dateLabel { Text(dateLabel).font(Theme.detailFont).foregroundStyle(Theme.textSecondary) }
                }
                if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
            }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.vertical, 6).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}
