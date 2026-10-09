import SwiftUI
import AnjadheCore
import UniformTypeIdentifiers
#if canImport(PhotosUI)
import PhotosUI
#endif
#if canImport(UIKit)
import UIKit
#endif
#if canImport(PDFKit)
import PDFKit
#endif

// Files in a phone chat (2026-10-08, by request: "chat in phone does not
// have file attach capability"). The desktop chat attaches up to four files
// to a message (agent-ui.js `attachFiles`): an image is scaled to 1568 px on
// its long side and sent as a JPEG for a model that can see; a PDF or a text
// file is sent as its text, up to 30,000 characters. The phone builds the
// same shape here (UIKit for the image, PDFKit for the PDF) and the Mac
// checks it again (main.js `phoneChatAttachments`, then AgentService's own
// sanitizer). Other kinds (Word, spreadsheets) are not read in a chat on
// the desktop either; they belong in Documents.

struct AttachRefusal: Error {
    let message: String
    init(_ m: String) { message = m }
}

struct ChatAttachment: Identifiable {
    let id = UUID()
    let name: String
    let kind: String          // image | pdf | text
    let json: JSONValue
    var symbol: String { kind == "image" ? "photo" : kind == "pdf" ? "doc.richtext" : "doc.text" }
}

enum ChatAttachments {
    static let maxFiles = 4
    static let maxChars = 30000
    /// The JPEG's bytes before base64 (which adds a third): ~150 KB on the
    /// wire, leaving the rest of the cloud's 256 KB for the conversation.
    static let maxImageBytes = 110 * 1024
    static let maxBytes = 5 * 1024 * 1024
    static let textExts: Set<String> = ["txt", "md", "markdown", "csv", "tsv", "json", "html", "htm", "xml", "log", "yaml", "yml"]

    /// Build an attachment from a file's bytes, or say why not.
    static func build(name: String, data: Data) -> Result<ChatAttachment, AttachRefusal> {
        let ext = (name as NSString).pathExtension.lowercased()
        if ["jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "bmp", "tif", "tiff"].contains(ext) {
            return image(name: name, data: data)
        }
        if ext == "pdf" { return pdf(name: name, data: data) }
        if textExts.contains(ext) {
            guard data.count <= maxBytes else { return .failure(AttachRefusal("\(name) is too large (max 5 MB)")) }
            guard let s = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else {
                return .failure(AttachRefusal("Couldn’t read \(name) as text"))
            }
            return .success(text(name: name, kind: "text", content: s, size: data.count, pages: nil))
        }
        return .failure(AttachRefusal("A chat reads photos, PDFs and text files. Add \(name) to Documents instead, and ask about it there."))
    }

    static func image(name: String, data: Data) -> Result<ChatAttachment, AttachRefusal> {
        #if canImport(UIKit)
        guard let img = UIImage(data: data) else { return .failure(AttachRefusal("Couldn’t read that image")) }
        // nenva cloud takes a chat request of at most 256 KB (Connect's
        // `jsonBodyLlm`), and the conversation rides in it too: a 1568 px
        // photo came to ~626 KB and was refused as "Bad request"
        // (2026-10-08). So the photo shrinks until it is small enough to
        // leave room for the chat, which still reads text and detail.
        var dim: CGFloat = 1280
        var jpeg: Data? = nil
        var target = CGSize.zero
        for _ in 0..<6 {
            let size = img.size
            let scale = min(1, dim / max(size.width, size.height))
            target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
            let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1; fmt.opaque = true
            let t = target
            let scaled = UIGraphicsImageRenderer(size: t, format: fmt).image { ctx in
                // JPEG has no alpha: flatten on white, as the desktop does.
                UIColor.white.setFill(); ctx.fill(CGRect(origin: .zero, size: t))
                img.draw(in: CGRect(origin: .zero, size: t))
            }
            jpeg = scaled.jpegData(compressionQuality: 0.6)
            if let j = jpeg, j.count <= maxImageBytes { break }
            dim *= 0.8
        }
        guard let jpeg = jpeg, jpeg.count <= maxImageBytes else { return .failure(AttachRefusal("That image is too large to send")) }
        let base = (name as NSString).deletingPathExtension
        let obj: [String: JSONValue] = [
            "name": .string(base + ".jpg"), "kind": .string("image"), "size": .number(Double(jpeg.count)),
            "mime": .string("image/jpeg"), "dataUrl": .string("data:image/jpeg;base64," + jpeg.base64EncodedString()),
            "width": .number(Double(target.width)), "height": .number(Double(target.height)),
        ]
        return .success(ChatAttachment(name: base + ".jpg", kind: "image", json: .object(obj)))
        #else
        return .failure(AttachRefusal("Images can’t be attached here"))
        #endif
    }

    static func pdf(name: String, data: Data) -> Result<ChatAttachment, AttachRefusal> {
        #if canImport(PDFKit)
        guard let doc = PDFDocument(data: data) else { return .failure(AttachRefusal("Couldn’t open that PDF")) }
        var parts: [String] = []
        for i in 0..<doc.pageCount { if let s = doc.page(at: i)?.string, !s.isEmpty { parts.append(s) } }
        let content = parts.joined(separator: "\n\n")
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .failure(AttachRefusal("That PDF has no text to read (a scan?). Add it to Documents, where your Mac can read scans."))
        }
        return .success(text(name: name, kind: "pdf", content: content, size: data.count, pages: doc.pageCount))
        #else
        return .failure(AttachRefusal("PDFs can’t be attached here"))
        #endif
    }

    static func text(name: String, kind: String, content: String, size: Int, pages: Int?) -> ChatAttachment {
        let clipped = String(content.prefix(maxChars))
        var obj: [String: JSONValue] = [
            "name": .string(name), "kind": .string(kind), "size": .number(Double(size)),
            "content": .string(clipped), "totalChars": .number(Double(content.count)),
            "truncated": .bool(content.count > maxChars),
        ]
        if let p = pages { obj["pages"] = .number(Double(p)) }
        return ChatAttachment(name: name, kind: kind, json: .object(obj))
    }
}

/// The composer's paperclip: a photo or a file.
struct AttachButton: View {
    var disabled = false
    let add: (ChatAttachment) -> Void
    let refused: (String) -> Void
    @State private var picking = false
    #if canImport(PhotosUI)
    @State private var pickingPhoto = false
    @State private var photo: PhotosPickerItem?
    #endif

    var body: some View {
        Menu {
            #if canImport(PhotosUI)
            Button { pickingPhoto = true } label: { Label("Photo", systemImage: "photo") }
            #endif
            Button { picking = true } label: { Label("File", systemImage: "doc") }
        } label: {
            Image(systemName: "paperclip")
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(disabled ? Theme.textQuaternary : Theme.textSecondary)
                .frame(width: 32, height: 32)
        }
        .disabled(disabled)
        .accessibilityLabel("Attach")
        .fileImporter(isPresented: $picking, allowedContentTypes: [.pdf, .image, .text, .plainText, .commaSeparatedText, .json, .html, .item],
                      allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls.prefix(ChatAttachments.maxFiles) {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url) else { refused("Couldn’t read \(url.lastPathComponent)"); continue }
                switch ChatAttachments.build(name: url.lastPathComponent, data: data) {
                case .success(let a): add(a)
                case .failure(let why): refused(why.message)
                }
            }
        }
        #if canImport(PhotosUI)
        .photosPicker(isPresented: $pickingPhoto, selection: $photo, matching: .images)
        .onChange(of: photo) { item in
            guard let item = item else { return }
            photo = nil
            item.loadTransferable(type: Data.self) { result in
                DispatchQueue.main.async {
                    guard case .success(let d) = result, let data = d else { refused("Couldn’t read that photo"); return }
                    switch ChatAttachments.image(name: "Photo.jpg", data: data) {
                    case .success(let a): add(a)
                    case .failure(let why): refused(why.message)
                    }
                }
            }
        }
        #endif
    }
}
