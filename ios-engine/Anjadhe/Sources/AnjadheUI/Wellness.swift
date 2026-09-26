import SwiftUI
import AnjadheCore

// Wellness — the one app where the phone is the BETTER device: you log water,
// meals, and mood where you are, not at your desk. The KINDS table is a
// compact copy of the desktop registry's data contract (same kind ids, same
// field ids, same 1–5 segment values, same `time`/`unit` stamping) so entries
// logged here are indistinguishable from the Mac's. Add + read on the phone;
// edit/charts stay on the Mac. Port of the old mobile/screens/wellness.js.

struct WellnessField {
    enum Kind { case number, select, segment, text }
    let id: String
    let label: String
    let type: Kind
    var min: Double? = nil
    var max: Double? = nil
    var required = false
    var unitKey: String? = nil
    var options: [String] = []
    var scale: [String] = []
}

struct WellnessKind {
    let id: String
    let label: String
    let mono: String
    var dateOnly = false
    let fields: [WellnessField]
}

enum WellnessKinds {
    /// Same ids/labels/ranges as WellnessApp.KINDS — the data contract.
    static let all: [WellnessKind] = [
        WellnessKind(id: "water", label: "Water", mono: "WA", fields: [
            WellnessField(id: "amount", label: "Amount", type: .number, min: 1, max: 4000, required: true, unitKey: "water")]),
        WellnessKind(id: "mood", label: "Mood & energy", mono: "MD", fields: [
            WellnessField(id: "mood", label: "Mood", type: .segment, required: true, scale: ["Rough", "Low", "Okay", "Good", "Great"]),
            WellnessField(id: "energy", label: "Energy", type: .segment, scale: ["Drained", "Low", "Okay", "Good", "High"]),
            WellnessField(id: "notes", label: "Notes (optional)", type: .text)]),
        WellnessKind(id: "meal", label: "Meal", mono: "ML", fields: [
            WellnessField(id: "mealType", label: "Meal", type: .select, options: ["Breakfast", "Lunch", "Dinner", "Snack", "Drink"]),
            WellnessField(id: "description", label: "What you ate", type: .text)]),
        WellnessKind(id: "weight", label: "Weight", mono: "WT", fields: [
            WellnessField(id: "value", label: "Weight", type: .number, min: 1, max: 1500, required: true, unitKey: "weight"),
            WellnessField(id: "notes", label: "Notes (optional)", type: .text)]),
        WellnessKind(id: "activity", label: "Activity", mono: "AC", fields: [
            WellnessField(id: "activityType", label: "Activity", type: .select, options: ["Walk", "Run", "Strength training", "Suryanamaskar", "Yoga", "Mindful breathing", "Cycling", "Swim", "Sport", "Other"]),
            WellnessField(id: "duration", label: "Duration (min)", type: .number, min: 1, max: 900),
            WellnessField(id: "notes", label: "Notes (optional)", type: .text)]),
        WellnessKind(id: "sleep", label: "Sleep", mono: "SL", dateOnly: true, fields: [
            WellnessField(id: "hours", label: "Hours slept", type: .number, min: 0, max: 24, required: true),
            WellnessField(id: "quality", label: "Quality", type: .segment, scale: ["Poor", "Fair", "Okay", "Good", "Great"])]),
        WellnessKind(id: "bp", label: "Blood pressure", mono: "BP", fields: [
            WellnessField(id: "systolic", label: "Systolic", type: .number, min: 50, max: 260, required: true),
            WellnessField(id: "diastolic", label: "Diastolic", type: .number, min: 30, max: 160, required: true),
            WellnessField(id: "pulse", label: "Pulse (bpm)", type: .number, min: 30, max: 220)]),
        WellnessKind(id: "steps", label: "Steps", mono: "ST", fields: [
            WellnessField(id: "value", label: "Steps for the day", type: .number, min: 0, max: 200000, required: true)]),
        WellnessKind(id: "medication", label: "Medication", mono: "RX", fields: [
            WellnessField(id: "name", label: "Name", type: .text, required: true),
            WellnessField(id: "dose", label: "Dose", type: .text)]),
        WellnessKind(id: "symptom", label: "Symptom", mono: "SY", fields: [
            WellnessField(id: "name", label: "Symptom", type: .text, required: true),
            WellnessField(id: "severity", label: "Severity", type: .segment, scale: ["Mild", "Low", "Moderate", "High", "Severe"])]),
    ]
    static let quick = ["water", "mood", "meal", "weight"]

    static func kind(_ id: String) -> WellnessKind? { all.first { $0.id == id } }

    static func unit(_ store: AppStore, _ unitKey: String) -> String {
        let units = store.blob("wellness")["settings"]?["units"]?.objectValue ?? [:]
        let defaults = ["weight": "lb", "water": "oz"]
        return units[unitKey]?.stringValue ?? defaults[unitKey] ?? ""
    }

    /// Local "yyyy-MM-dd'T'HH:mm" — the desktop's `time` stamp.
    static func nowLocal() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd'T'HH:mm"; return f.string(from: Date())
    }

    static func addEntry(_ store: AppStore, kind: String, values: [String: JSONValue]) {
        var fields = values
        fields["kind"] = .string(kind)
        fields["createdAt"] = .string(KVStore.nowISO())
        // The desktop stamps createdAt only (no modifiedAt on wellness entries).
        var blob = store.blob("wellness")
        var entries = blob["entries"]?.arrayValue ?? []
        fields["id"] = .string(AppStore.newId())
        entries.append(.object(fields))
        blob["entries"] = .array(entries)
        store.saveBlob("wellness", blob)
    }

    /// One human line per entry, from its own fields (the JS `summarize`).
    static func summarize(_ e: JSONValue) -> String {
        let k = kind(e["kind"]?.stringValue ?? "")
        func str(_ v: JSONValue?) -> String {
            guard let v = v else { return "" }
            if let s = v.stringValue { return s }
            if let n = v.numberValue { return n == n.rounded() ? String(Int(n)) : String(n) }
            return ""
        }
        func orQ(_ v: JSONValue?) -> String { let s = str(v); return s.isEmpty ? "?" : s }
        func seg(_ field: String, _ v: JSONValue?) -> String {
            if let f = k?.fields.first(where: { $0.id == field }), !f.scale.isEmpty, let n = v?.numberValue {
                let i = Int(n) - 1
                if i >= 0 && i < f.scale.count { return f.scale[i] }
            }
            return str(v)
        }
        func present(_ v: JSONValue?) -> Bool { !str(v).isEmpty && v?.numberValue != 0 }
        switch e["kind"]?.stringValue ?? "" {
        case "water": return orQ(e["amount"]) + " " + str(e["unit"])
        case "mood": return seg("mood", e["mood"]) + (present(e["energy"]) ? " · energy " + seg("energy", e["energy"]).lowercased() : "")
        case "meal": return [str(e["mealType"]), str(e["description"])].filter { !$0.isEmpty }.joined(separator: " · ")
        case "weight": return orQ(e["value"]) + " " + str(e["unit"])
        case "activity": return [str(e["activityType"]), present(e["duration"]) ? str(e["duration"]) + " min" : ""].filter { !$0.isEmpty }.joined(separator: " · ")
        case "sleep": return orQ(e["hours"]) + " h" + (present(e["quality"]) ? " · " + seg("quality", e["quality"]).lowercased() : "")
        case "bp": return orQ(e["systolic"]) + "/" + orQ(e["diastolic"]) + (present(e["pulse"]) ? " · " + str(e["pulse"]) + " bpm" : "")
        case "steps": return orQ(e["value"]) + " steps"
        case "medication": return [str(e["name"]), str(e["dose"])].filter { !$0.isEmpty }.joined(separator: " · ")
        case "symptom": return str(e["name"])
        default: return str(e["notes"])
        }
    }
}

/// A pill button (`.wellness-quick-btn` / `.chip`).
private struct WellnessPill: View {
    let label: String
    var prominent = false
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label).font(.system(size: 14, weight: prominent ? .semibold : .medium))
                .foregroundStyle(prominent ? Theme.bg : Theme.text)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(Capsule().fill(prominent ? Theme.text : Theme.surface))
                .overlay(Capsule().strokeBorder(prominent ? Color.clear : Theme.border))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Home

struct WellnessView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router

    private var entries: [JSONValue] {
        (store.blob("wellness")["entries"]?.arrayValue ?? []).sorted {
            ($0["time"]?.stringValue ?? "") > ($1["time"]?.stringValue ?? "")
        }
    }

    var body: some View {
        let all = entries
        let today = DateLogic.todayStr()
        let todayCount = all.filter { ($0["time"]?.stringValue ?? "").hasPrefix(today) }.count
        let cutoff = DateLogic.dateStr(Calendar.current.date(byAdding: .day, value: -14, to: Date()) ?? Date())
        let recent = Array(all.filter { ($0["time"]?.stringValue ?? "") >= cutoff }.prefix(40))

        ScreenColumn {
            ScreenHead("Wellness", sub: todayCount > 0 ? "\(todayCount) " + (todayCount == 1 ? "entry today" : "entries today") : "Nothing logged today")

            VStack(alignment: .leading, spacing: 10) {
                SectionLabel("Quick log")
                HStack(spacing: 8) {
                    WellnessPill(label: "+ Water", prominent: true) { quickWater() }
                    WellnessPill(label: "Mood") { router.push(.wellnessLog("mood")) }
                    WellnessPill(label: "Meal") { router.push(.wellnessLog("meal")) }
                    WellnessPill(label: "Weight") { router.push(.wellnessLog("weight")) }
                }
                WellnessFlow(spacing: 8) {
                    ForEach(WellnessKinds.all.filter { !WellnessKinds.quick.contains($0.id) }, id: \.id) { k in
                        WellnessPill(label: k.label) { router.push(.wellnessLog(k.id)) }
                    }
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("Recent")
                if recent.isEmpty {
                    EmptyText("Nothing in the last two weeks.")
                } else {
                    CardList {
                        ForEach(Array(recent.enumerated()), id: \.element) { i, e in
                            row(e, last: i == recent.count - 1)
                        }
                    }
                }
            }
        }
        .pushedScreen()
    }

    private func row(_ e: JSONValue, last: Bool) -> some View {
        let k = WellnessKinds.kind(e["kind"]?.stringValue ?? "")
        let mono = k?.mono ?? "··"
        let label = k?.label ?? (e["kind"]?.stringValue ?? "")
        let time = e["time"]?.stringValue ?? ""
        let summary = WellnessKinds.summarize(e)
        var sub = label + " · " + DateLogic.relDate(time)
        if time.count > 10 {
            let hhmm = String(time.dropFirst(11).prefix(5))
            sub += " " + DateLogic.fmtTime(hhmm)
        }
        return RowView(summary.isEmpty ? label : summary, sub: sub, last: last, leading: {
            Text(mono)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 32, height: 32)
                .background(RoundedRectangle(cornerRadius: Theme.radiusSm).fill(Theme.surface))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusSm).strokeBorder(Theme.border))
        }, trailing: { EmptyView() })
    }

    private func quickWater() {
        let unit = WellnessKinds.unit(store, "water")
        WellnessKinds.addEntry(store, kind: "water", values: [
            "time": .string(WellnessKinds.nowLocal()),
            "amount": .number(unit == "ml" ? 250 : 8),
            "unit": .string(unit),
        ])
        router.showToast("Water logged")
    }
}

/// A wrapping row of chips (the JS `.chip-row`).
private struct WellnessFlow: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > 0 && x + sz.width > width { x = 0; y += rowH + spacing; rowH = 0 }
            x += sz.width + spacing
            rowH = Swift.max(rowH, sz.height)
        }
        return CGSize(width: width == .infinity ? x : width, height: y + rowH)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > bounds.minX && x + sz.width > bounds.maxX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sz))
            x += sz.width + spacing
            rowH = Swift.max(rowH, sz.height)
        }
    }
}

// MARK: - Log form

struct WellnessLogView: View {
    let kind: String
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @State private var text: [String: String] = [:]     // number + text fields
    @State private var select: [String: String] = [:]   // select fields
    @State private var segment: [String: Int] = [:]     // segment fields (1–5)

    var body: some View {
        ScreenColumn(spacing: 18) {
            if let k = WellnessKinds.kind(kind) {
                ScreenHead(k.label)
                ForEach(k.fields, id: \.id) { f in field(f) }
                PrimaryButton(label: "Save") { save(k) }
            } else {
                EmptyText("Unknown kind.")
            }
        }
        .pushedScreen()
    }

    private func fieldLabelText(_ f: WellnessField) -> String {
        if let u = f.unitKey { return f.label + " (" + WellnessKinds.unit(store, u) + ")" }
        return f.label
    }

    @ViewBuilder private func field(_ f: WellnessField) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(fieldLabelText(f)).font(.caption).foregroundStyle(Theme.textSecondary)
            switch f.type {
            case .number:
                inputBox(TextField("", text: Binding(get: { text[f.id] ?? "" }, set: { text[f.id] = $0 }))
                    .numberKeyboard())
            case .text:
                inputBox(TextField("", text: Binding(get: { text[f.id] ?? "" }, set: { text[f.id] = $0 })))
            case .select:
                let cur = select[f.id] ?? f.options.first ?? ""
                Menu {
                    ForEach(f.options, id: \.self) { o in Button(o) { select[f.id] = o } }
                } label: {
                    HStack {
                        Text(cur).foregroundStyle(Theme.text)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundStyle(Theme.textTertiary)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: Theme.radiusSm).fill(Theme.surface))
                    .overlay(RoundedRectangle(cornerRadius: Theme.radiusSm).strokeBorder(Theme.border))
                }
            case .segment:
                HStack(spacing: 4) {
                    ForEach(Array(f.scale.enumerated()), id: \.offset) { i, word in
                        let on = segment[f.id] == i + 1
                        Button { segment[f.id] = i + 1 } label: {
                            Text(word).font(.system(size: 12, weight: .medium)).lineLimit(1).minimumScaleFactor(0.7)
                                .frame(maxWidth: .infinity).padding(.vertical, 8)
                                .background(RoundedRectangle(cornerRadius: 6).fill(on ? Theme.text : Theme.surface))
                                .foregroundStyle(on ? Theme.bg : Theme.textSecondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func inputBox<V: View>(_ v: V) -> some View {
        v.font(.system(size: 16)).foregroundStyle(Theme.text)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: Theme.radiusSm).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusSm).strokeBorder(Theme.border))
    }

    private func save(_ k: WellnessKind) {
        var values: [String: JSONValue] = [
            "time": .string(k.dateOnly ? DateLogic.todayStr() + "T07:00" : WellnessKinds.nowLocal()),
        ]
        for f in k.fields {
            var v: JSONValue = .null
            switch f.type {
            case .number:
                let raw = (text[f.id] ?? "").trimmingCharacters(in: .whitespaces)
                if raw.isEmpty { v = .null }
                else if let n = Double(raw) {
                    if let mn = f.min, n < mn { router.showToast(f.label + " looks out of range"); return }
                    if let mx = f.max, n > mx { router.showToast(f.label + " looks out of range"); return }
                    v = .number(n)
                } else { router.showToast(f.label + " looks out of range"); return }
            case .text:
                let s = (text[f.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                v = .string(s)
            case .select:
                v = .string(select[f.id] ?? f.options.first ?? "")
            case .segment:
                v = segment[f.id].map { .number(Double($0)) } ?? .null
            }
            let empty = v.isNull || (v.stringValue?.isEmpty ?? false)
            if f.required && empty { router.showToast(f.label + " is required"); return }
            values[f.id] = v
            if let u = f.unitKey { values["unit"] = .string(WellnessKinds.unit(store, u)) }
        }
        WellnessKinds.addEntry(store, kind: k.id, values: values)
        router.showToast(k.label + " saved")
        router.pop()
    }
}

private extension View {
    @ViewBuilder func numberKeyboard() -> some View {
        #if os(iOS)
        self.keyboardType(.decimalPad)
        #else
        self
        #endif
    }
}
