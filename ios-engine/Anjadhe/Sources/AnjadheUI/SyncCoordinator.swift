import Foundation
import Combine
import AnjadheCore
#if canImport(WebKit)
import WebKit
#endif
#if canImport(UIKit)
import UIKit
#endif

/// Stage-1 sync bridge (docs/MOBILE_NATIVE.md). Hosts the proven JS channel +
/// delta-sync + pairing stack in a hidden WKWebView, but backs its storage with
/// the native `KVStore` via `native-bridge.js`:
///   • on load, the native store snapshot is hydrated into the JS mirror;
///   • the JS `__anjadheStore` forwards every write here as a `persist` message,
///     which we apply to `KVStore` (and bump the UI);
///   • native UI writes are forwarded INTO the JS mirror (`applyLocalWrite`) so
///     the channel uploads them — without re-posting back (loop-free).
///
/// The same channel carries the assistant (`sendChat` / `chat` events — the
/// phone is a remote channel to the Mac's assistant, the Telegram shape on our
/// own encrypted pipe) and the Mac-served views (`requestView`).
public final class SyncCoordinator: NSObject, ObservableObject {
    /// Mirrors AnjadheSync states: offline / connecting / syncing / idle / error.
    @Published public private(set) var state: String = "offline"
    /// Which rung of the transport ladder the channel rides (mobile-sync.js):
    /// "direct" (the Mac's own LAN relay — same network), "relay" (hosted), or
    /// nil while offline.
    @Published public private(set) var transport: String?
    @Published public private(set) var paired: Bool = false
    @Published public private(set) var lastPairError: String?
    /// Set once the hidden host has loaded its scripts and hydrated.
    @Published public private(set) var hostReady = false

    /// A chat push from the Mac: `kind` is "chat-ack" | "chat-reply" | "chat-error".
    public struct ChatEvent { public let kind: String; public let text: String; public let convId: String? }
    public let chat = PassthroughSubject<ChatEvent, Never>()

    private let store: AppStore
    #if canImport(WebKit)
    private var webView: WKWebView?
    #endif
    private var viewPending: [String: (Result<JSONValue, Error>) -> Void] = [:]
    private var viewCounter = 0

    public init(store: AppStore) {
        self.store = store
        super.init()
    }

    /// Start the hidden sync host. `baseURL` points at the bundled web assets
    /// directory (the app's `public/`) so the script `src`s resolve; the default
    /// host HTML loads native-bridge.js + the channel bundle + pairing + sync.
    public func start(baseURL: URL, html: String? = nil) {
        // Route native user writes into the JS mirror so the channel uploads
        // them (remote-applied writes don't fire these, so no loop).
        store.kv.onLocalWrite = { [weak self] key, value in self?.pushLocal(key, value) }
        store.kv.onLocalDelete = { [weak self] key in self?.pushLocalDelete(key) }
        #if canImport(WebKit)
        let cfg = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.add(self, name: "anjadhe")
        cfg.userContentController = ucc
        let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: cfg)
        wv.navigationDelegate = self
        self.webView = wv
        #if os(iOS)
        // A WKWebView that isn't in the view hierarchy gets its JS timers and
        // network deprioritized/suspended by iOS — which silently stalls the
        // sync channel (pairing's local crypto still works, but the relay
        // connection never runs). Attach it to the window, effectively invisible
        // but live, so sync actually happens.
        attachToWindow(wv)
        #endif
        wv.loadHTMLString(html ?? Self.defaultHostHTML, baseURL: baseURL)
        #endif
    }

    #if canImport(WebKit) && os(iOS)
    private func attachToWindow(_ wv: WKWebView, attempt: Int = 0) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first
        guard let window = window else {
            if attempt < 12 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.attachToWindow(wv, attempt: attempt + 1) } }
            return
        }
        wv.alpha = 0.01                       // >0 so iOS keeps it running, but invisible
        wv.isUserInteractionEnabled = false
        window.addSubview(wv)
        window.sendSubviewToBack(wv)
    }
    #endif

    // MARK: Pairing

    /// Pair with the Mac using a scanned/pasted offer string (the JSON the Mac's
    /// pairing QR encodes). Runs the channel handshake in the JS host and reports
    /// back via `paired`/`lastPairError`.
    public func pair(offerText: String) {
        lastPairError = nil
        let js = "window.AnjadhePairing && AnjadhePairing.pairWithOffer(\(Self.jsString(offerText)))"
            + ".then(function(r){ try{ window.webkit.messageHandlers.anjadhe.postMessage({type:'pairResult', ok:!!r.ok, error:r.error||''}); }catch(e){} });"
        eval(js)
    }

    /// Drop the stored pairing — the phone stops syncing until paired again.
    public func forgetPairing() {
        eval("window.AnjadhePairing && AnjadhePairing.forget();")
        paired = false
        state = "offline"
        transport = nil
    }

    // MARK: Sync

    /// Forward a native UI write into the JS mirror so the channel uploads it.
    public func pushLocal(_ key: String, _ value: JSONValue) {
        guard let json = Self.jsonString(value) else { return }
        eval("window.__anjadheBridge && __anjadheBridge.applyLocalWrite(\(Self.jsString(key)), \(json), \(Self.jsString(KVStore.nowISO())));")
    }

    public func pushLocalDelete(_ key: String) {
        eval("window.__anjadheBridge && __anjadheBridge.applyLocalDelete(\(Self.jsString(key)), \(Self.jsString(KVStore.nowISO())));")
    }

    public func triggerSync() {
        eval("window.AnjadheSync && AnjadheSync.sync();")
    }

    /// "Re-download from Mac": drop this phone's copy of every synced key (the
    /// pairing and identity stay), forget the synced-once flag so the next
    /// sync is Mac-authoritative (empty manifest → the Mac sends everything
    /// and asks for nothing), and sync now. Edits made only on this phone
    /// that never uploaded are lost — the caller confirms first.
    public func resyncFromMac() {
        let keep = "anjadhe:channel:"
        store.kv.purge(keepPrefix: keep)
        // A native delete travels to the JS mirror as a tombstone, so its
        // `load(LS_SYNCED_ONCE)` reads null and the manifest goes out empty.
        store.kv.delete("anjadhe:channel:synced-once", now: KVStore.nowISO())
        eval("window.__anjadheBridge && __anjadheBridge.reset(\(Self.jsString(keep)));")
        store.flush()
        DispatchQueue.main.async { self.store.bump() }
        triggerSync()
    }

    /// The app came to the foreground: reconnect or refresh state so the user
    /// sees the latest data without tapping (the hidden host's own
    /// visibilitychange does not fire reliably).
    public func onForeground() {
        eval("window.AnjadheSync && (AnjadheSync.resume ? AnjadheSync.resume() : AnjadheSync.sync());")
    }

    /// The last lines the sync host logged (state changes, each connection
    /// candidate's failure reason, applied changes) — Settings shows them so
    /// a drop can be diagnosed on the phone, without a cable.
    @Published public private(set) var logLines: [String] = []
    private static let logCap = 60
    private static let logTime: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm:ss"; return f }()
    private func logLine(_ text: String) {
        let line = Self.logTime.string(from: Date()) + "  " + text
        DispatchQueue.main.async {
            self.logLines.append(line)
            if self.logLines.count > Self.logCap { self.logLines.removeFirst(self.logLines.count - Self.logCap) }
        }
    }

    // MARK: Assistant chat (data lane 3)

    /// Send a chat message to the Mac's assistant. `completion(false)` when
    /// there is no live channel (the host kicks off a connect attempt). The
    /// reply comes through `chat` as chat-reply/chat-error, and through sync
    /// either way.
    public func sendChat(_ text: String, convId: String?, fresh: Bool, completion: @escaping (Bool) -> Void) {
        let opts = "{convId: \(convId.map(Self.jsString) ?? "null"), fresh: \(fresh ? "true" : "false")}"
        let js = "(function(){ try { return !!(window.AnjadheSync && AnjadheSync.sendChat(\(Self.jsString(text)), \(opts))); } catch (e) { return false; } })()"
        #if canImport(WebKit)
        guard let wv = webView else { completion(false); return }
        wv.evaluateJavaScript(js) { result, _ in
            DispatchQueue.main.async { completion((result as? Bool) ?? false) }
        }
        #else
        completion(false)
        #endif
    }

    // MARK: Mac-served views (data lane 2)

    /// Ask the Mac for a read-only view digest ('insights' | 'news' |
    /// 'portfolio'). Fails with 'offline', 'timed out', or the Mac's own error.
    public func requestView(_ name: String, params: [String: JSONValue]? = nil, completion: @escaping (Result<JSONValue, Error>) -> Void) {
        viewCounter += 1
        let reqId = "n\(viewCounter)_\(Int(Date().timeIntervalSince1970 * 1000))"
        viewPending[reqId] = completion
        let paramsJS = params.flatMap { Self.jsonString(.object($0)) } ?? "null"
        let js = "(function(){ var post = function(m){ try { window.webkit.messageHandlers.anjadhe.postMessage(m); } catch(e){} };"
            + " if (!window.AnjadheSync || !AnjadheSync.requestView) { post({type:'viewError', reqId:\(Self.jsString(reqId)), error:'offline'}); return; }"
            + " AnjadheSync.requestView(\(Self.jsString(name)), \(paramsJS)).then(function(d){ post({type:'viewData', reqId:\(Self.jsString(reqId)), data:(d === undefined ? null : d)}); },"
            + " function(e){ post({type:'viewError', reqId:\(Self.jsString(reqId)), error:String((e && e.message) || e || 'view failed')}); }); })();"
        #if canImport(WebKit)
        guard webView != nil else { settleView(reqId, .failure(ViewError("offline"))); return }
        eval(js)
        #else
        settleView(reqId, .failure(ViewError("offline")))
        #endif
    }

    public struct ViewError: LocalizedError {
        public let message: String
        public init(_ m: String) { message = m }
        public var errorDescription: String? { message }
    }

    private func settleView(_ reqId: String, _ result: Result<JSONValue, Error>) {
        guard let cb = viewPending.removeValue(forKey: reqId) else { return }
        DispatchQueue.main.async { cb(result) }
    }

    // MARK: internals

    private func eval(_ js: String) {
        #if canImport(WebKit)
        webView?.evaluateJavaScript(js, completionHandler: nil)
        #endif
    }

    /// Hydrate the JS mirror with the full native store snapshot.
    fileprivate func hydrate() {
        var rows: [String: WireRow] = [:]
        for (k, e) in store.kv.snapshot() { rows[k] = WireRow(entry: e) }
        print("[sync] hydrate JS mirror from native snapshot — \(rows.count) keys (\(store.kv.liveKeys.count) live)")
        guard let data = try? JSONEncoder().encode(rows), let json = String(data: data, encoding: .utf8) else { return }
        eval("window.__anjadheBridge && __anjadheBridge.hydrate(\(json));")
        // Re-derive the paired flag from the now-hydrated pairing record so the
        // UI shows the truth on launch.
        eval("try { window.webkit.messageHandlers.anjadhe.postMessage({ type:'pairedStatus', ok: !!(window.AnjadhePairing && AnjadhePairing.isPaired()) }); } catch(e){}")
        eval("window.AnjadheSync && AnjadheSync.sync();")
        DispatchQueue.main.async { self.hostReady = true }
    }

    private static func jsString(_ s: String) -> String {
        (try? JSONEncoder().encode(s)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
    }
    private static func jsonString(_ v: JSONValue) -> String? {
        (try? JSONEncoder().encode(v)).flatMap { String(data: $0, encoding: .utf8) }
    }

    static let defaultHostHTML = """
    <!doctype html><html><head><meta charset="utf-8"></head><body>
    <script>
      // Forward the sync stack's console output to native (Xcode console) so an
      // on-device sync can be debugged. Must run BEFORE the other scripts.
      (function () {
        ['log', 'warn', 'error'].forEach(function (lvl) {
          var orig = console[lvl];
          console[lvl] = function () {
            try { window.webkit.messageHandlers.anjadhe.postMessage({ type: 'log', level: lvl, text: Array.prototype.map.call(arguments, String).join(' ') }); } catch (e) {}
            try { orig.apply(console, arguments); } catch (e) {}
          };
        });
        window.onerror = function (m, s, l) { try { window.webkit.messageHandlers.anjadhe.postMessage({ type: 'log', level: 'error', text: 'window.onerror: ' + m + ' @' + l }); } catch (e) {} };
      })();
    </script>
    <script src="js/adapter/native-bridge.js"></script>
    <script src="js/channel/channel.bundle.js"></script>
    <script src="js/adapter/mobile-pairing.js"></script>
    <script src="js/adapter/mobile-sync.js"></script>
    <script>
      // Forward AnjadheSync state changes and chat pushes to native.
      (function hook() {
        if (window.AnjadheSync && window.AnjadheSync.onStateChange) {
          window.AnjadheSync.onStateChange(function (s) {
            var t = null;
            try { t = window.AnjadheSync.getTransport ? window.AnjadheSync.getTransport() : null; } catch (e) {}
            try { window.webkit.messageHandlers.anjadhe.postMessage({ type: 'syncState', state: s, transport: t }); } catch (e) {}
          });
          if (window.AnjadheSync.onChat) {
            window.AnjadheSync.onChat(function (m) {
              try { window.webkit.messageHandlers.anjadhe.postMessage({ type: 'chat', kind: String(m.type || ''), text: String(m.text || ''), convId: m.convId || null }); } catch (e) {}
            });
          }
        } else { setTimeout(hook, 200); }
      })();
    </script>
    </body></html>
    """

    // Wire shapes for (de)serializing across the bridge.
    struct WireRow: Encodable {
        let entry: RemoteEntry
        enum CodingKeys: String, CodingKey { case value, deleted, modifiedAt }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(entry.modifiedAt, forKey: .modifiedAt)
            if entry.deleted { try c.encode(true, forKey: .deleted) }
            else { try c.encode(entry.value ?? .null, forKey: .value) }
        }
    }
    struct BridgeMessage: Decodable {
        let type: String
        let key: String?
        let entry: WireEntry?
        let state: String?
        let transport: String?
        let ok: Bool?
        let error: String?
        let level: String?
        let text: String?
        let kind: String?
        let convId: String?
        let reqId: String?
        let data: JSONValue?
    }
    struct WireEntry: Decodable {
        let value: JSONValue?
        let deleted: Bool?
        let modifiedAt: String
    }
}

#if canImport(WebKit)
extension SyncCoordinator: WKScriptMessageHandler {
    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let data = try? JSONSerialization.data(withJSONObject: message.body) else {
            print("[sync] DROPPED bridge message — not JSON-serializable")
            return
        }
        guard let msg = try? JSONDecoder().decode(BridgeMessage.self, from: data) else {
            let preview = String(data: data, encoding: .utf8)?.prefix(160) ?? ""
            print("[sync] DROPPED undecodable bridge message: \(preview)")
            return
        }
        switch msg.type {
        case "persist":
            guard let key = msg.key, let entry = msg.entry else { print("[sync] persist missing key/entry"); return }
            if entry.deleted == true {
                store.kv.applyRemoteDelete(key, modifiedAt: entry.modifiedAt)
            } else {
                store.kv.applyRemote(key, value: entry.value ?? .null, modifiedAt: entry.modifiedAt)
            }
            // The channel identity/pairing MUST survive even an immediate quit
            // right after pairing — flush it to disk synchronously instead of
            // waiting on the debounce, or pairing is lost on the next launch.
            if key.hasPrefix("anjadhe:channel:") { print("[sync] channel key persisted (flushed): \(key)"); store.flush() }
            DispatchQueue.main.async { self.store.bump() }
        case "log":
            print("[sync] \(msg.level ?? "log"): \(msg.text ?? "")")
            let t = msg.text ?? ""
            if t.contains("[mobile-sync]") { logLine(t.replacingOccurrences(of: "[mobile-sync] ", with: "")) }
        case "pairedStatus":
            let ok = msg.ok ?? false
            print("[sync] paired status on launch: \(ok)")
            DispatchQueue.main.async { self.paired = ok }
        case "syncState":
            let t = msg.transport
            if let s = msg.state { DispatchQueue.main.async { self.state = s; self.transport = t } }
            print("[sync] state → \(msg.state ?? "?") (\(t ?? "no transport"))")
            logLine("state → \(msg.state ?? "?")" + (t.map { " (\($0))" } ?? ""))
        case "pairResult":
            logLine(msg.ok == true ? "paired" : "pairing failed: \(msg.error ?? "")")
            DispatchQueue.main.async {
                self.paired = msg.ok ?? false
                self.lastPairError = (msg.ok == true) ? nil : (msg.error ?? "Pairing failed")
            }
            if msg.ok == true { triggerSync() }
        case "chat":
            let ev = ChatEvent(kind: msg.kind ?? "", text: msg.text ?? "", convId: msg.convId)
            DispatchQueue.main.async { self.chat.send(ev) }
        case "viewData":
            guard let reqId = msg.reqId else { return }
            settleView(reqId, .success(msg.data ?? .null))
        case "viewError":
            guard let reqId = msg.reqId else { return }
            settleView(reqId, .failure(ViewError(msg.error ?? "view failed")))
        default:
            break
        }
    }
}

extension SyncCoordinator: WKNavigationDelegate {
    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hydrate()
    }
}
#endif
