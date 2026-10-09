import Darwin
import Foundation
import UIKit

/// Finding a Flow Server on the home network (FlowNative.discover, as
/// FlowNative.java's, @flow/core/discovery's question on UDP port 7878; each
/// server answers the asker directly).
///
/// Android broadcasts the question. An iPhone app may only broadcast with an
/// entitlement Apple hands out on request, so here it goes to every address
/// of the phone's network, one by one (a /24, the usual home network; of a
/// bigger one the /24 around the phone). Asking an address directly needs
/// only iOS's "find devices on your local network" permission, which iOS asks
/// for the first time. The servers need nothing new.
enum Discovery {
    static let port: UInt16 = 7878
    private static let question = Array(#"{"app":"flow-discover","v":1}"#.utf8)

    /// The phone's own IPv4 addresses on its networks (Wi-Fi, a wired adapter),
    /// with their masks, host order. VPNs (Tailscale) and mobile data are not asked.
    static func ownNetworks() -> [(ip: UInt32, mask: UInt32)] {
        var out: [(ip: UInt32, mask: UInt32)] = []
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return out }
        defer { freeifaddrs(list) }
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let a = cursor {
            defer { cursor = a.pointee.ifa_next }
            let flags = Int32(truncatingIfNeeded: a.pointee.ifa_flags)
            guard (flags & IFF_UP) != 0, (flags & IFF_RUNNING) != 0, (flags & IFF_LOOPBACK) == 0, (flags & IFF_POINTOPOINT) == 0,
                  let addr = a.pointee.ifa_addr, addr.pointee.sa_family == sa_family_t(AF_INET),
                  let netmask = a.pointee.ifa_netmask else { continue }
            let name = String(cString: a.pointee.ifa_name)
            if ["utun", "ipsec", "pdp_ip", "awdl", "llw", "anpi", "ap"].contains(where: { name.hasPrefix($0) }) { continue }
            let ip = addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
            let mask = netmask.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
            if mask == 0xffff_ffff || ip == 0 { continue }
            out.append((ip, mask))
        }
        return out
    }

    static func text(_ ip: UInt32) -> String {
        "\(ip >> 24).\((ip >> 16) & 255).\((ip >> 8) & 255).\(ip & 255)"
    }

    /// Asks for `timeoutMs`, the question sent `sends` times (a datagram can get
    /// lost). Answers { answers: [{ address, text }], own: [this phone's addresses] }.
    static func run(timeoutMs: Int, sends: Int) -> [String: Any] {
        let networks = ownNetworks()
        var targets: [UInt32] = []
        var seen = Set<UInt32>()
        for n in networks {
            let mask = max(n.mask, 0xffff_ff00)
            let base = n.ip & mask
            let hosts = ~mask
            guard hosts >= 2 else { continue }
            for h in 1..<hosts {
                let ip = base | h
                if seen.insert(ip).inserted { targets.append(ip) }
            }
        }
        var answers: [[String: Any]] = []
        let own = networks.map { text($0.ip) }
        let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard fd >= 0 else { return ["answers": answers, "own": own] }
        defer { _ = close(fd) }
        var wait = timeval(tv_sec: 0, tv_usec: 100_000)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &wait, socklen_t(MemoryLayout<timeval>.size))
        var noSigpipe: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size))

        let start = Date()
        let end = start.addingTimeInterval(Double(timeoutMs) / 1000)
        var sent = 0
        var failed = 0
        var buffer = [UInt8](repeating: 0, count: 2048)
        while Date() < end {
            if sent < sends && Date() >= start.addingTimeInterval(Double(sent) * 0.4) {
                for (i, ip) in targets.enumerated() {
                    if send(fd, to: ip) < 0 { failed += 1 }
                    // Not all at once: the network's queue would drop them.
                    if i % 32 == 31 { _ = usleep(2000) }
                }
                sent += 1
            }
            var from = sockaddr_in()
            var length = socklen_t(MemoryLayout<sockaddr_in>.size)
            let n = buffer.withUnsafeMutableBytes { bytes in
                withUnsafeMutablePointer(to: &from) { p in
                    p.withMemoryRebound(to: sockaddr.self, capacity: 1) { recvfrom(fd, bytes.baseAddress, bytes.count, 0, $0, &length) }
                }
            }
            guard n > 0, n <= 1024 else { continue }
            answers.append([
                "address": text(UInt32(bigEndian: from.sin_addr.s_addr)),
                "text": String(decoding: buffer[0..<n], as: UTF8.self),
            ])
        }
        FlowLog.i("discovery: asked \(targets.count) addresses on \(networks.count) network(s) \(sent)x"
            + (failed > 0 ? ", \(failed) sends refused" : "") + ", \(answers.count) answer(s)")
        return ["answers": answers, "own": own, "refused": answers.isEmpty && failed > 0]
    }

    /// After a search iOS refused (sends fail "no route to host" until this app
    /// may use the local network): while iOS's question about it is up (the
    /// app not in front meanwhile), waits for the answer, up to `seconds`.
    /// True once it is allowed; false at once without the question (it was
    /// answered "Don't Allow" before: Settings > Flow > Local Network).
    static func waitUntilAllowed(seconds: Double) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        let front = { DispatchQueue.main.sync { MainActor.assumeIsolated { UIApplication.shared.applicationState == .active } } }
        guard !front() else { return false }
        while Date() < end, !front() { _ = usleep(250_000) }
        // Allowed takes a moment to apply.
        for _ in 0..<12 {
            if probe() { return true }
            _ = usleep(250_000)
        }
        return false
    }

    /// Whether one question to the network goes out now.
    private static func probe() -> Bool {
        guard let n = ownNetworks().first else { return false }
        let base = n.ip & max(n.mask, 0xffff_ff00)
        let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard fd >= 0 else { return false }
        defer { _ = close(fd) }
        var noSigpipe: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size))
        return send(fd, to: base | (n.ip == base | 1 ? 2 : 1)) >= 0
    }

    private static func send(_ fd: Int32, to ip: UInt32) -> Int {
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr = in_addr(s_addr: ip.bigEndian)
        return withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                sendto(fd, question, question.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
    }
}
