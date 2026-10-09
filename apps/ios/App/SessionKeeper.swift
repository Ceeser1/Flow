import Foundation
import UIKit

/// Keeps this phone's Active Session on the Flow Server while Flow is out of
/// sight, as SessionKeeper.java.
///
/// The page tells the server what plays (renderer/app/session.js), but soon
/// after Flow leaves the screen iOS stops its page: no timers, no network.
/// The server keeps a session while its host's live channel is open; once
/// that breaks (another network, the server restarted, its sign-in ended) the
/// session was gone until the page woke, and other devices did not see what
/// this phone plays.
///
/// So after each time it told the server, the page hands over what it told
/// (keep), and while Flow is out of sight this tells it again every `every`
/// seconds, with the song, place and playing as the player has them now
/// (paused: once). A 401 signs in again (ServerSignIn), the token going to the
/// player and the page. Once Flow is seen again, the page tells it itself.
final class SessionKeeper {
    static let shared = SessionKeeper()

    private let every: TimeInterval = 5
    private let timeout: TimeInterval = 8
    private let queue = DispatchQueue(label: "io.github.ceeser1.flow.session")

    // What the page told last: the server's address, the token, this app's id,
    // the state (without its lists), the output delay's shift of the place (s),
    // and server time minus the phone's (ms). No state: not hosting.
    private var base = ""
    private var token = ""
    private var client = ""
    private var state: [String: Any]?
    private var shift = 0.0
    private var offset = 0.0
    private var away = false
    private var sending = false
    private var signingIn = false
    private var refused = false     // could not sign in again: nothing more until the page speaks
    private var toldPlaying: Bool?  // what it last told: playing or not (nil: nothing yet)
    private var toldAway = false
    private var problem = ""
    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.setAway(true)
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.setAway(false)
        })
    }

    /// The page's last word: { base, token, client, state, shift, offset }, or
    /// { off: true } when this app hosts nothing (stopped, in another's session).
    func keep(_ o: [String: Any]) {
        guard !FlowPlayer.bool(o["off"]), var st = o["state"] as? [String: Any] else {
            state = nil
            schedule()
            return
        }
        // The lists stay as the server has them.
        st["ids"] = nil
        st["queue"] = nil
        state = st
        base = o["base"] as? String ?? ""
        client = o["client"] as? String ?? ""
        if let t = o["token"] as? String, !t.isEmpty { token = t }
        shift = FlowPlayer.num(o["shift"]) ?? 0
        offset = FlowPlayer.num(o["offset"]) ?? 0
        toldPlaying = nil
        refused = false
        schedule()
    }

    /// The player signed in again itself: the token this uses from now.
    func signedIn(_ t: String) {
        token = t
    }

    private func setAway(_ isAway: Bool) {
        away = isAway
        toldAway = false
        schedule()
    }

    private func schedule() {
        timer?.invalidate()
        timer = nil
        guard away, state != nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: every, repeats: true) { [weak self] _ in self?.tick() }
    }

    private func tick() {
        guard away, let told = state, !base.isEmpty else { return }
        guard let now = FlowPlayer.shared.sessionNow() else { return }
        // Paused: told once; the server lists it a while, as the page's would be.
        if !now.playing && toldPlaying == false { return }
        if sending || signingIn || refused { return }
        var st = told
        // On to another song since (the page could not say).
        if now.key != (st["songId"] as? String ?? "") {
            st["songId"] = now.key
            st["title"] = now.title
            st["artist"] = now.artist
            st["mix"] = ""
            st["duration"] = now.duration
        }
        st["playing"] = now.playing
        st["position"] = max(0, now.position + shift)
        st["at"] = Date().timeIntervalSince1970 * 1000 + offset
        send(st, playing: now.playing)
    }

    private func send(_ st: [String: Any], playing: Bool) {
        let body: [String: Any] = ["type": "state", "state": st, "client": client]
        let url = base + "/api/sessions"
        let t = token
        let wait = timeout
        sending = true
        queue.async {
            let answer = ServerSignIn.post(url, body, token: t, timeout: wait)
            DispatchQueue.main.async { self.sent(answer.status, playing: playing) }
        }
    }

    private func sent(_ status: Int, playing: Bool) {
        sending = false
        if status == 200 {
            toldPlaying = playing
            if !toldAway {
                toldAway = true
                FlowLog.i("Flow out of sight: the player keeps its session on the server")
            }
            if !problem.isEmpty { FlowLog.i("session told again") }
            problem = ""
            return
        }
        if status == 401 {
            signIn()
            return
        }
        let now = status < 0 ? "no answer" : "answered \(status)"
        if now != problem { FlowLog.i("session not told: \(now)") }
        problem = now
    }

    /// The server ended this app's sign-in: again, as the player does; the next tick tells it.
    private func signIn() {
        signingIn = true
        FlowLog.i("session refused (signed out): signing in again")
        ServerSignIn.start(base: base) { [weak self] r in
            guard let self = self else { return }
            self.signingIn = false
            guard let t = r.token else {
                FlowLog.i("could not sign in again: \(r.problem)")
                self.refused = true
                return
            }
            self.token = t
            FlowPlayer.shared.tookToken(t, profileOk: r.profileOk)
            FlowLog.i("signed in again" + (r.profileOk ? "" : " (\(r.problem))"))
        }
    }
}
