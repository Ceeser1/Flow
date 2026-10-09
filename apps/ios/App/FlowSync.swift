import CryptoKit
import Foundation
import Network
import Security
import UIKit

/// What the page asks of the phone and needs back at once: window.FlowSync,
/// as FlowSync.java answers it on Android. The shared client
/// (@flow/core/client) reads its files, its secrets and the phone's name
/// synchronously, as Node lets it on the desktop. A Capacitor plugin call is
/// always asynchronous, and WKWebView has one synchronous way into the app:
/// prompt(). So window.FlowSync (`script`, put into the page before it loads)
/// asks prompt("flow-sync", <the call as JSON>), and FlowUIDelegate answers it
/// from here, on the main thread, before Capacitor would show a dialog.
/// Capacitor itself asks for cookies that way.
///
/// Every path must lie in Flow's own files or cache (FlowPaths). Calls that
/// change something answer "" when done, else what went wrong; reads answer
/// null for a file that is not there.
final class FlowSync {
    static let marker = "flow-sync"
    static let shared = FlowSync()

    /// window.FlowSync: the methods of FlowSync.java, each a prompt().
    static let script = """
    (function () {
      if (window.FlowSync) return;
      function call(m, a) {
        var r = window.prompt('flow-sync', JSON.stringify({ m: m, a: a }));
        if (r === null || r === undefined) throw new Error('Flow could not reach the phone (' + m + ').');
        var o = JSON.parse(r);
        if (o.e) throw new Error(o.e);
        return o.r;
      }
      var api = {};
      ['info', 'deviceName', 'isMetered', 'readText', 'writeText', 'readBase64', 'writeBase64', 'exists', 'size',
        'mkdir', 'remove', 'rename', 'copy', 'list', 'sha1', 'encrypt', 'decrypt'].forEach(function (m) {
        api[m] = function () { return call(m, Array.prototype.slice.call(arguments)); };
      });
      Object.defineProperty(window, 'FlowSync', { value: Object.freeze(api) });
    })();
    """

    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var meteredNow = false
    private var key: SymmetricKey?

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self = self else { return }
            self.lock.lock()
            // Mobile data, a phone's hotspot, or Low Data Mode.
            self.meteredNow = path.isExpensive || path.isConstrained
            self.lock.unlock()
        }
        monitor.start(queue: DispatchQueue(label: "io.github.ceeser1.flow.network"))
    }

    /// Whether the network in use costs per byte (as FlowSync.java isMetered).
    var metered: Bool {
        lock.lock()
        defer { lock.unlock() }
        return meteredNow
    }

    /// Answers one call, { m: method, a: [arguments] }: { r: result } or { e: what went wrong }.
    func answer(_ request: String) -> String {
        guard let data = request.data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let m = o["m"] as? String else {
            return reply(["e": "Not a call."])
        }
        let a = o["a"] as? [Any] ?? []
        let s = { (i: Int) -> String in i < a.count ? (a[i] as? String ?? "") : "" }
        let b = { (i: Int) -> Bool in i < a.count ? (a[i] as? Bool ?? false) : false }
        let r: Any
        switch m {
        case "info": r = info()
        case "deviceName": r = deviceName()
        case "isMetered": r = metered
        case "readText": r = readText(s(0)) ?? NSNull()
        case "writeText": r = write(s(0), Data(s(1).utf8))
        case "readBase64": r = read(s(0))?.base64EncodedString() ?? NSNull()
        case "writeBase64": r = write(s(0), Data(base64Encoded: s(1), options: .ignoreUnknownCharacters) ?? Data())
        case "exists": r = exists(s(0))
        case "size": r = size(s(0))
        case "mkdir": r = mkdir(s(0))
        case "remove": r = remove(s(0), recursive: b(1))
        case "rename": r = rename(s(0), s(1))
        case "copy": r = copy(s(0), s(1))
        case "list": r = list(s(0))
        case "sha1": r = sha1(s(0))
        case "encrypt": r = encrypt(s(0))
        case "decrypt": r = decrypt(s(0))
        default: return reply(["e": "Flow has no call \(m) on the iPhone."])
        }
        return reply(["r": r])
    }

    private func reply(_ o: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: o) else {
            return #"{"e":"The answer could not be sent."}"#
        }
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: the phone

    /// { files, cache, device, sdk, real }: where Flow keeps things, by the names
    /// the page keeps (FlowPaths), the folders they are now, and the phone's name.
    private func info() -> String {
        let o: [String: Any] = [
            "files": FlowPaths.filesName,
            "cache": FlowPaths.cacheName,
            "device": deviceName(),
            "sdk": ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
            "real": ["files": FlowPaths.files.path, "cache": FlowPaths.cache.path],
        ]
        let data = (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// The phone's name. iOS tells apps only "iPhone" (the name its owner gave
    /// it needs an entitlement Apple hands out on request).
    func deviceName() -> String {
        let name = UIDevice.current.name.trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? "iPhone" : name
    }

    // MARK: files

    private func readText(_ path: String) -> String? {
        guard let data = read(path) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    private func read(_ path: String) -> Data? {
        guard let url = FlowPaths.resolve(path) else { return nil }
        return try? Data(contentsOf: url)
    }

    /// Written to a temporary file renamed over the old one, so a file is never half written.
    private func write(_ path: String, _ data: Data) -> String {
        guard let url = FlowPaths.resolve(path) else { return "Not one of Flow's files: \(path)" }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return ""
        } catch {
            return error.localizedDescription
        }
    }

    private func exists(_ path: String) -> Bool {
        guard let url = FlowPaths.resolve(path) else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    /// A file's size in bytes, -1 when it is not there (or is a folder).
    private func size(_ path: String) -> Double {
        var dir: ObjCBool = false
        guard let url = FlowPaths.resolve(path),
              FileManager.default.fileExists(atPath: url.path, isDirectory: &dir), !dir.boolValue,
              let n = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber else {
            return -1
        }
        return n.doubleValue
    }

    private func mkdir(_ path: String) -> String {
        guard let url = FlowPaths.resolve(path) else { return "Not one of Flow's files: \(path)" }
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            return ""
        } catch {
            return error.localizedDescription
        }
    }

    /// Removes a file, or a folder with `recursive`. Not being there is fine.
    private func remove(_ path: String, recursive: Bool) -> String {
        guard let url = FlowPaths.resolve(path) else { return "Not one of Flow's files: \(path)" }
        var dir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &dir) else { return "" }
        if dir.boolValue && !recursive { return "That is a folder: \(path)" }
        do {
            try FileManager.default.removeItem(at: url)
            return ""
        } catch {
            return error.localizedDescription
        }
    }

    private func rename(_ from: String, _ to: String) -> String {
        guard let src = FlowPaths.resolve(from), let dest = FlowPaths.resolve(to) else {
            return "Not one of Flow's files: \(from) -> \(to)"
        }
        let fm = FileManager.default
        guard fm.fileExists(atPath: src.path) else { return "Not there: \(from)" }
        do {
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: dest.path) {
                _ = try fm.replaceItemAt(dest, withItemAt: src)
            } else {
                try fm.moveItem(at: src, to: dest)
            }
            return ""
        } catch {
            return error.localizedDescription
        }
    }

    private func copy(_ from: String, _ to: String) -> String {
        guard let data = read(from) else { return "Not there: \(from)" }
        return write(to, data)
    }

    /// A folder's entries as JSON: [{ name, size, dir }], [] when it is not there.
    private func list(_ path: String) -> String {
        var out: [[String: Any]] = []
        let fm = FileManager.default
        if let url = FlowPaths.resolve(path), let names = try? fm.contentsOfDirectory(atPath: url.path) {
            for name in names {
                let p = url.appendingPathComponent(name).path
                var dir: ObjCBool = false
                guard fm.fileExists(atPath: p, isDirectory: &dir) else { continue }
                let size = dir.boolValue ? 0 : (((try? fm.attributesOfItem(atPath: p))?[.size] as? NSNumber)?.doubleValue ?? 0)
                out.append(["name": name, "size": size, "dir": dir.boolValue])
            }
        }
        let data = (try? JSONSerialization.data(withJSONObject: out)) ?? Data("[]".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// A file's SHA-1 as hex, "" when it cannot be read (covers: their version).
    private func sha1(_ path: String) -> String {
        guard let url = FlowPaths.resolve(path), let handle = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? handle.close() }
        var hash = Insecure.SHA1()
        while let chunk = try? handle.read(upToCount: 65536), !chunk.isEmpty {
            hash.update(data: chunk)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: secrets (the server's password, a profile's PIN)
    //
    // Encrypted with a key kept in the iPhone's Keychain, which never leaves
    // the phone: "k:<iv>:<data>", base64, as on Android. What cannot be
    // decrypted (another phone's, a key that is gone) counts as no secret.

    private static let keyQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "io.github.ceeser1.flow.secrets",
        kSecAttrAccount as String: "flow-secrets",
    ]

    private func secretKey() -> SymmetricKey? {
        if let key = key { return key }
        var query = FlowSync.keyQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data, data.count == 32 {
            key = SymmetricKey(data: data)
            return key
        }
        let fresh = SymmetricKey(size: .bits256)
        var add = FlowSync.keyQuery
        add[kSecValueData as String] = fresh.withUnsafeBytes { Data($0) }
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemDelete(FlowSync.keyQuery as CFDictionary)
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            FlowLog.i("secrets: the Keychain refused a key (\(status))")
            return nil
        }
        key = fresh
        return fresh
    }

    private func encrypt(_ text: String) -> String {
        guard !text.isEmpty, let key = secretKey(), let box = try? AES.GCM.seal(Data(text.utf8), using: key) else { return "" }
        let iv = box.nonce.withUnsafeBytes { Data($0) }
        return "k:" + iv.base64EncodedString() + ":" + (box.ciphertext + box.tag).base64EncodedString()
    }

    private func decrypt(_ stored: String) -> String {
        let parts = stored.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "k", let key = secretKey(),
              let iv = Data(base64Encoded: String(parts[1])),
              let all = Data(base64Encoded: String(parts[2])), all.count >= 16,
              let nonce = try? AES.GCM.Nonce(data: iv),
              let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: all.dropLast(16), tag: all.suffix(16)),
              let plain = try? AES.GCM.open(box, using: key) else {
            return ""
        }
        return String(decoding: plain, as: UTF8.self)
    }

    /// The secret of the page's settings in plain text, for native sign-in (ServerSignIn).
    func reveal(_ stored: String) -> String {
        decrypt(stored)
    }
}
