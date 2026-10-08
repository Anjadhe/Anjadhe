import SwiftUI
import AnjadheCore
import UniformTypeIdentifiers
#if canImport(PhotosUI)
import PhotosUI
#endif

// Documents on the phone (2026-10-08) — the desktop's ONE Documents page
// (js/apps/documents/documents-page.js, D1–D3): one list of everything the
// person has in writing, over two stores. WRITTEN things are the synced
// `notes` blob (opened in the phone's editor); FILES are the Mac's library
// folder, which never leaves the Mac, so their listing and each file's text
// come from the Mac (`documents` / `document` views, read-only). Same shape
// as the Mac: the serif title, a lede joined from counts, one search box,
// All · Written · Files, the tags as a row of words, Today · This week ·
// Earlier, rows with one quiet line. Every value is a stored field (D2).

struct DocRow: Identifiable {
    let id: String          // "note:<id>" | "doc:<id>"
    let ref: String
    let written: Bool
    let byNenva: Bool
    let title: String
    let at: Date?
    let tags: [String]
    let fileKind: String
    let status: String
}

enum DocumentsLogic {
    static func rows(notes: [JSONValue], files: [JSONValue]) -> [DocRow] {
        var out: [DocRow] = []
        for n in notes {
            guard let id = n["id"]?.stringValue, n["deletedAt"] == nil || n["deletedAt"] == .null else { continue }
            let t = (n["title"]?.stringValue ?? "").trimmingCharacters(in: .whitespaces)
            let at = (n["modifiedAt"]?.stringValue ?? n["updatedAt"]?.stringValue ?? n["createdAt"]?.stringValue).flatMap(DateLogic.parseISO)
            out.append(DocRow(id: "note:" + id, ref: id, written: true, byNenva: n["template"]?.stringValue == "assistant",
                              title: t.isEmpty ? "Untitled" : t, at: at,
                              tags: (n["tags"]?.arrayValue ?? []).compactMap { $0.stringValue?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty },
                              fileKind: "", status: ""))
        }
        for f in files {
            guard let id = f["id"]?.stringValue else { continue }
            out.append(DocRow(id: "doc:" + id, ref: id, written: false, byNenva: false,
                              title: f["title"]?.stringValue ?? "Untitled",
                              at: f["at"]?.stringValue.flatMap(DateLogic.parseISO),
                              tags: (f["tags"]?.arrayValue ?? []).compactMap { $0.stringValue },
                              fileKind: f["kind"]?.stringValue ?? "File", status: f["status"]?.stringValue ?? ""))
        }
        return out.sorted { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }
    }

    static func lede(_ rows: [DocRow]) -> String {
        let w = rows.filter { $0.written }.count, f = rows.count - w
        var bits: [String] = []
        if w > 0 { bits.append("\(w) written") }
        if f > 0 { bits.append("\(f) file\(f == 1 ? "" : "s")") }
        return bits.joined(separator: " · ")
    }

    /// The tags as one row of words: a path tag's first segment, counted
    /// case-insensitively, shown as most often written, most used first.
    static func tagRow(_ rows: [DocRow]) -> [(tag: String, n: Int)] {
        var counts: [String: (n: Int, spell: [String: Int])] = [:]
        for r in rows { for t in r.tags {
            let root = t.split(separator: "/").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
            guard !root.isEmpty else { continue }
            var e = counts[root.lowercased()] ?? (0, [:])
            e.n += 1; e.spell[root, default: 0] += 1
            counts[root.lowercased()] = e
        } }
        return counts.values.map { e in
            (tag: e.spell.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.first!.key, n: e.n)
        }.sorted { $0.n != $1.n ? $0.n > $1.n : $0.tag < $1.tag }
    }
    static func hasTag(_ r: DocRow, _ tag: String) -> Bool {
        r.tags.contains { ($0.split(separator: "/").first.map(String.init) ?? "").trimmingCharacters(in: .whitespaces).lowercased() == tag.lowercased() }
    }
    static func matches(_ r: DocRow, _ query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if q.isEmpty { return true }
        let hay = "\(r.title) \(r.tags.joined(separator: " ")) \(r.fileKind)".lowercased()
        return q.split(separator: " ").allSatisfy { hay.contains($0) }
    }
    static func groups(_ rows: [DocRow], now: Date = Date()) -> [(String, [DocRow])] {
        let cal = Calendar.current
        let start = cal.startOfDay(for: now)
        let week = start.addingTimeInterval(-6 * 86400)
        var t: [DocRow] = [], w: [DocRow] = [], e: [DocRow] = []
        for r in rows {
            let at = r.at ?? .distantPast
            if at >= start { t.append(r) } else if at >= week { w.append(r) } else { e.append(r) }
        }
        return [("Today", t), ("This week", w), ("Earlier", e)].filter { !$0.1.isEmpty }
    }
    static func when(_ at: Date?, now: Date = Date()) -> String {
        guard let d = at else { return "" }
        let f = DateFormatter()
        if Calendar.current.isDate(d, inSameDayAs: now) { f.timeStyle = .short; f.dateStyle = .none; return f.string(from: d) }
        let sameYear = Calendar.current.component(.year, from: d) == Calendar.current.component(.year, from: now)
        f.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "MMMdyyyy")
        return f.string(from: d)
    }
    static func subline(_ r: DocRow) -> String {
        var bits: [String] = []
        if r.written { bits.append(r.byNenva ? "Written by nenva" : "Written by you") }
        else { bits.append(r.fileKind + (r.status == "error" ? " · could not be read" : (!r.status.isEmpty && r.status != "indexed") ? " · being read" : "")) }
        if !r.tags.isEmpty { bits.append(r.tags.prefix(3).map { $0.split(separator: "/").joined(separator: " › ") }.joined(separator: ", ")) }
        let w = when(r.at); if !w.isEmpty { bits.append(w) }
        return bits.joined(separator: " · ")
    }
}

struct DocumentsView: View {
    @EnvironmentObject var store: AppStore
    @EnvironmentObject var router: Router
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var sync: SyncCoordinator
    @State private var query = ""
    @State private var kind = "all"      // all | written | files
    @State private var tag: String?
    @StateObject private var upload = PhoneUpload()
    @State private var picking = false
    #if canImport(PhotosUI)
    @State private var photo: PhotosPickerItem?
    @State private var pickingPhoto = false
    #endif

    var body: some View {
        let _ = store.revision
        let _ = views.revision
        let snap = views.view("documents", ttl: 5 * 60)
        let files = snap.data?["files"]?.arrayValue ?? []
        let all = DocumentsLogic.rows(notes: store.items("notes", "notes"), files: files)
        let tags = DocumentsLogic.tagRow(all)
        let shown = all.filter { r in
            (kind == "all" || (kind == "written") == r.written)
                && (tag == nil || DocumentsLogic.hasTag(r, tag!))
                && DocumentsLogic.matches(r, query)
        }
        return ScreenColumn(spacing: 16) {
            ScreenHead("Documents", sub: DocumentsLogic.lede(all)) {
                // The desktop's two doors in (D1): write something, or add a
                // file — copied into the Mac's Documents folder.
                Menu {
                    Button { router.push(Capture.newNote(store)) } label: { Label("New document", systemImage: "square.and.pencil") }
                    Button { picking = true } label: { Label("Add a file", systemImage: "doc.badge.plus") }
                    #if canImport(PhotosUI)
                    Button { pickingPhoto = true } label: { Label("Add a photo or scan", systemImage: "photo") }
                    #endif
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 17, weight: .regular)).foregroundStyle(Theme.text)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(Theme.surface))
                        .overlay(Circle().strokeBorder(Theme.border))
                }
                .accessibilityLabel("Add")
            }
            if let st = upload.status {
                HStack(spacing: 10) {
                    if upload.busy { ProgressView().controlSize(.small) }
                    Text(st).font(.system(size: 14)).foregroundStyle(upload.failed ? Theme.danger : Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: Theme.radiusMd).fill(Theme.blueWash))
            }
            SearchField(placeholder: "Search documents…", text: $query)
            HStack(spacing: 18) {
                word("All", on: kind == "all") { kind = "all" }
                word("Written", n: all.filter { $0.written }.count, on: kind == "written") { kind = "written" }
                word("Files", n: all.filter { !$0.written }.count, on: kind == "files") { kind = "files" }
                Spacer(minLength: 0)
            }
            if !tags.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 14) {
                        ForEach(tags.prefix(20), id: \.tag) { t in
                            Button { tag = tag?.lowercased() == t.tag.lowercased() ? nil : t.tag } label: {
                                HStack(spacing: 4) {
                                    Text(t.tag).font(.system(size: 13, weight: tag?.lowercased() == t.tag.lowercased() ? .semibold : .regular))
                                    Text("\(t.n)").font(.system(size: 11)).foregroundStyle(Theme.textQuaternary)
                                }
                                .foregroundStyle(tag?.lowercased() == t.tag.lowercased() ? Theme.accent : Theme.textSecondary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            if kind != "written" && files.isEmpty {
                Text(!sync.paired ? "Files live on your Mac; pair this phone to see them."
                     : snap.error != nil ? "Your Mac can’t be reached, so files aren’t listed right now."
                     : snap.data == nil ? "Getting your files from your Mac…" : "")
                    .font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
            }
            if shown.isEmpty {
                EmptyText(all.isEmpty ? "Nothing yet. What nenva writes for you, and what you write, lands here." : "Nothing matches.")
            } else {
                ForEach(DocumentsLogic.groups(shown), id: \.0) { g in
                    VStack(alignment: .leading, spacing: 8) {
                        SectionLabel(g.0)
                        CardList {
                            ForEach(Array(g.1.prefix(200).enumerated()), id: \.element.id) { i, r in
                                RowView(r.title, sub: DocumentsLogic.subline(r), last: i == min(g.1.count, 200) - 1) {
                                    Image(systemName: r.written ? "doc.text" : "doc")
                                        .font(.system(size: 14)).foregroundStyle(Theme.textSecondary).frame(width: 20)
                                } trailing: { EmptyView() }
                                .onTapGesture { router.push(r.written ? .note(r.ref) : .file(r.ref)) }
                            }
                        }
                    }
                }
            }
        }
        .refreshable { views.refresh("documents") }
        .pushedScreen()
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: false) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            upload.sendFile(url, sync: sync) { views.refresh("documents") }
        }
        #if canImport(PhotosUI)
        .photosPicker(isPresented: $pickingPhoto, selection: $photo, matching: .images)
        .onChange(of: photo) { item in
            guard let item = item else { return }
            photo = nil
            upload.sendPhoto(item, sync: sync) { views.refresh("documents") }
        }
        #endif
    }

    private func word(_ label: String, n: Int? = nil, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text(label).font(.system(size: 15, weight: on ? .semibold : .regular))
                if let n = n, n > 0 { Text("\(n)").font(.system(size: 12)).foregroundStyle(Theme.textTertiary) }
            }
            .foregroundStyle(on ? Theme.text : Theme.textTertiary)
            .padding(.vertical, 4)
            .overlay(alignment: .bottom) { if on { Rectangle().fill(Theme.accent).frame(height: 2).offset(y: 4) } }
        }
        .buttonStyle(.plain)
    }
}

/// One file from the Mac's Documents, read on the phone: the reader's tidied
/// Markdown when it has one, else the parsed text.
struct FileReader: View {
    let id: String
    @EnvironmentObject var views: MacViews
    @EnvironmentObject var router: Router

    var body: some View {
        let _ = views.revision
        let list = views.view("documents", ttl: 5 * 60).data?["files"]?.arrayValue ?? []
        let meta = list.first { $0["id"]?.stringValue == id }
        let snap = views.view("doc:" + id, ttl: 10 * 60, request: "document", params: ["id": .string(id)])
        let text = snap.data?["text"]?.stringValue ?? ""
        return ScreenColumn(spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text((meta?["kind"]?.stringValue ?? "File").uppercased())
                    .font(.system(size: 11.5, weight: .semibold)).tracking(0.7).foregroundStyle(Theme.textTertiary)
                Text(meta?["title"]?.stringValue ?? "Document").displayStyle(26)
                    .fixedSize(horizontal: false, vertical: true)
                if let tags = meta?["tags"]?.arrayValue, !tags.isEmpty {
                    Text(tags.compactMap { $0.stringValue?.split(separator: "/").joined(separator: " › ") }.joined(separator: ", "))
                        .font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
                }
            }
            if !text.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    if snap.data?["tidy"]?.boolValue == true {
                        MarkdownView(text: text)
                    } else {
                        Text(text).font(.system(size: 15)).lineSpacing(5).foregroundStyle(Theme.text)
                            .textSelection(.enabled)
                    }
                    if snap.data?["truncated"]?.boolValue == true {
                        Text("The rest is on your Mac.").font(.system(size: 13)).italic().foregroundStyle(Theme.textTertiary)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: Theme.radiusLg).fill(Theme.surface))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusLg).strokeBorder(Theme.border))
            } else if let err = snap.error {
                EmptyText(err)
            } else if snap.data != nil {
                EmptyText("No text could be read from this file. Open it on your Mac.")
            } else {
                EmptyText("Getting it from your Mac…")
            }
            AskDoor(label: "Ask nenva about this document…") {
                router.openCompose(prefill: "About my document “\(meta?["title"]?.stringValue ?? "this file")”: ")
            }
        }
        .pushedScreen()
    }
}

// MARK: - Adding a file from the phone (2026-10-08)

/// Sends one file to the Mac's Documents in pieces (`document-upload`,
/// answered by the Mac's main process, which imports it the way the
/// desktop's "Add files" does). One upload at a time; the status line says
/// where it stands, and the Mac's own refusal is shown as it was written.
final class PhoneUpload: ObservableObject {
    @Published var status: String?
    @Published var busy = false
    @Published var failed = false
    static let piece = 384 * 1024

    func sendFile(_ url: URL, sync: SyncCoordinator, done: @escaping () -> Void) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { show("Couldn’t read that file.", failed: true); return }
        send(data, name: url.lastPathComponent, sync: sync, done: done)
    }

    #if canImport(PhotosUI)
    func sendPhoto(_ item: PhotosPickerItem, sync: SyncCoordinator, done: @escaping () -> Void) {
        show("Getting the photo…", busy: true)
        let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
        item.loadTransferable(type: Data.self) { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard case .success(let d) = result, let data = d else { self.show("Couldn’t read that photo.", failed: true); return }
                let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH.mm"
                self.send(data, name: "Photo \(f.string(from: Date())).\(ext)", sync: sync, done: done)
            }
        }
    }
    #endif

    private func show(_ s: String?, busy: Bool = false, failed: Bool = false) {
        status = s; self.busy = busy; self.failed = failed
    }

    private func send(_ data: Data, name: String, sync: SyncCoordinator, done: @escaping () -> Void) {
        guard sync.paired else { show("Pair this phone with your Mac to add files.", failed: true); return }
        guard !data.isEmpty else { show("That file is empty.", failed: true); return }
        let total = max(1, Int((Double(data.count) / Double(Self.piece)).rounded(.up)))
        guard total <= 160 else { show("That file is too large to send from the phone.", failed: true); return }
        let id = UUID().uuidString
        show("Sending “\(name)” to your Mac…", busy: true)
        func next(_ i: Int) {
            let lo = i * Self.piece, hi = min(data.count, lo + Self.piece)
            let params: [String: JSONValue] = [
                "upload": .string(id), "name": .string(name),
                "index": .number(Double(i)), "total": .number(Double(total)),
                "data": .string(data.subdata(in: lo..<hi).base64EncodedString()),
            ]
            sync.requestView("document-upload", params: params) { [weak self] result in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    switch result {
                    case .failure(let e):
                        let msg = e.localizedDescription
                        self.show(msg == "offline" ? "Your Mac can’t be reached right now; try again when it is." : msg, failed: true)
                    case .success(let d):
                        if d["done"]?.boolValue == true {
                            self.show("Added “\(name)” to Documents. Your Mac is reading it now.")
                            done()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                                if self?.busy == false && self?.failed == false { self?.status = nil }
                            }
                        } else {
                            if total > 1 { self.show("Sending “\(name)”… \(Int(Double(i + 1) / Double(total) * 100))%", busy: true) }
                            next(i + 1)
                        }
                    }
                }
            }
        }
        next(0)
    }
}
