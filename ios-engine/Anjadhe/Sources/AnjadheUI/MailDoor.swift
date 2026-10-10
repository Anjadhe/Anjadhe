import SwiftUI
import AnjadheCore
#if canImport(UIKit)
import UIKit
#endif

// Opening an email from the phone (2026-10-02, reported: email cards on Now
// did not open the message in Gmail or Mail — they opened Gmail's WEB page
// in Safari). The Mac sends what each app needs (mobile-views.js
// `_emailDoor`): the Gmail thread id, the RFC Message-ID, and the web link.
// The person picks their mail app once (asked on the first open, changeable
// in Settings); each attempt falls through to the next when iOS has no app
// for it, ending on the web link, so a tap always lands somewhere.
//
// The Gmail app's thread link (`googlegmail:///cv=<thread>`) is the form
// Gmail answers to but does not document; if it ever stops, Gmail opens on
// its inbox and the web link is still one tap away. `message://<Message-ID>`
// is Mail's own scheme and finds the message in any account Mail holds.

enum MailDoor {
    static let key = "mail-app"            // "gmail" | "mail"; absent = ask

    static var choice: String? {
        let v = UserDefaults.standard.string(forKey: key)
        return v == "gmail" || v == "mail" ? v : nil
    }
    static func setChoice(_ v: String?) {
        if let v = v { UserDefaults.standard.set(v, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
    }

    /// The links to try, in order, for one app.
    static func candidates(_ e: [String: JSONValue], app: String) -> [URL] {
        var out: [String] = []
        let thread = e["thread"]?.stringValue ?? ""
        let header = e["header"]?.stringValue ?? ""
        let web = e["web"]?.stringValue ?? ""
        if app == "mail" {
            if !header.isEmpty {
                let enc = "<\(header)>".addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: ".@_-+"))) ?? ""
                out.append("message://" + enc)
            }
        } else {
            if !thread.isEmpty { out.append("googlegmail:///cv=\(thread)/accountId=1&create-new-tab") }
        }
        if !web.isEmpty { out.append(web) }
        return out.compactMap(URL.init(string:))
    }

    /// Open the message in `app`, falling through the candidates.
    static func open(_ e: [String: JSONValue], app: String, failed: @escaping () -> Void) {
        tryOpen(candidates(e, app: app), failed: failed)
    }

    private static func tryOpen(_ urls: [URL], failed: @escaping () -> Void) {
        guard let first = urls.first else { failed(); return }
        #if canImport(UIKit)
        UIApplication.shared.open(first, options: [:]) { ok in
            if !ok { DispatchQueue.main.async { tryOpen(Array(urls.dropFirst()), failed: failed) } }
        }
        #else
        failed()
        #endif
    }
}

/// Attaches the one-time "Open email in" question to a screen. A view calls
/// `request(email)`; with a choice already made it opens straight away.
struct MailDoorModifier: ViewModifier {
    @Binding var pending: [String: JSONValue]?
    @EnvironmentObject var router: Router

    func body(content: Content) -> some View {
        content.confirmationDialog("Open email in", isPresented: Binding(
            get: { pending != nil }, set: { if !$0 { pending = nil } }), titleVisibility: .visible) {
            Button("Gmail") { pick("gmail") }
            Button("Mail") { pick("mail") }
            Button("Cancel", role: .cancel) { pending = nil }
        } message: {
            Text("nenva will remember this. You can change it in Settings.")
        }
    }

    private func pick(_ app: String) {
        MailDoor.setChoice(app)
        if let e = pending { MailDoor.open(e, app: app) { router.showToast("Couldn’t open that email") } }
        pending = nil
    }
}

extension View {
    func mailDoor(_ pending: Binding<[String: JSONValue]?>) -> some View { modifier(MailDoorModifier(pending: pending)) }
}

/// Settings › Email: which app opens a message.
struct MailDoorSettingsCard: View {
    @State private var choice: String = MailDoor.choice ?? "ask"
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Open email in").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
            Picker("Open email in", selection: $choice) {
                Text("Gmail").tag("gmail")
                Text("Mail").tag("mail")
                Text("Ask").tag("ask")
            }
            .pickerStyle(.segmented)
            .onChange(of: choice) { v in MailDoor.setChoice(v == "ask" ? nil : v) }
            Text("Where an email from Now or Today opens on this phone.")
                .font(.system(size: 13)).foregroundStyle(Theme.textTertiary)
        }
        .themedCard(padding: 14)
    }
}
