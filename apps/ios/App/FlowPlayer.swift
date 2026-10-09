import AVFoundation
import MediaPlayer
import UIKit

/// What the page hears from the player (through FlowAudio); every event
/// carries the page's id of the song it is about.
protocol FlowPlayerEvents: AnyObject {
    func onState(_ state: [String: Any])
    func onEnded(_ id: String)
    /// `status`: the server's answer when it refused the song (401: signed out), else 0;
    /// `unsupported`: iOS cannot play the file itself (its kind, or it is broken).
    func onError(_ id: String, _ message: String, _ status: Int, _ unsupported: Bool)
    /// The player signed in to the server again itself: the app's token now.
    func onSignedIn(_ token: String)
    /// On to the next song (`reason`: auto, next, repeat); `heard`: seconds of the one before.
    func onAdvance(_ from: String, _ id: String, _ key: String, _ heard: Double, _ reason: String)
    /// Previous on the lock screen: the page goes back (it knows the songs before).
    func onPrevious()
}

/// The iPhone's player, FlowPlayer.java's counterpart: one AVQueuePlayer for
/// as long as Flow runs. The page drives it through FlowAudio as its audio
/// engine (apps/android/src/engine.js), with lists of operations, and hears
/// back its state, with the same states, events and ids as on Android.
///
/// Its queue is the song playing and the songs the page says come after it,
/// so it moves on by itself, without a gap, while the page is out of sight
/// (iOS stops a page that is not shown); Next on the lock screen goes there
/// too. Each move is told to the page ("advance", with how long the song
/// before was heard). Listens without a page are kept in a file until one
/// asks (attach).
///
/// iOS's own controls work it: the lock screen, Control Center, headphones
/// and the car (Now Playing and its remote commands). A call or another app's
/// sound pauses it (and gives it back when iOS says so), unplugged
/// headphones pause it. The sleep timer runs here too: the music fades out
/// over its last seconds, then pauses.
///
/// Songs from a Flow Server are fetched by StreamLoader: with the newest token,
/// signed in again when the server ended this app's session (the page takes
/// the new token over), and patiently through a network that drops. A song
/// that still fails is told to the page; AVQueuePlayer moves past it by
/// itself (see failed).
///
/// Equalize volume turns a song down by the player's volume, up through an
/// audio tap (Boost). Song Transition (crossfade) as on Android: shortly
/// before a song ends, a second player (the tail) is made ready at the place
/// the transition starts; there it plays the song's end on, fading it down,
/// while this player moves on to the next song, fading it up. A pause, a seek
/// or another song cuts the tail.
///
/// Everything here runs on the main thread.
final class FlowPlayer: NSObject {
    static let shared = FlowPlayer()

    /// AVPlayer's states as Media3's, which the page goes by (engine.js).
    private enum St {
        static let idle = 1
        static let buffering = 2
        static let ready = 3
        static let ended = 4
    }

    /// What the page knows a song in the queue by.
    private struct Tag {
        let id: String
        let key: String
        let gain: Float
        let src: String
        var meta: [String: Any]?
        // Turning the song up (gains over 1), put on its sound once needed.
        let boost = Boost()
    }

    let player = AVQueuePlayer()
    weak var events: FlowPlayerEvents?

    private var tags: [ObjectIdentifier: Tag] = [:]
    private var id = ""          // the page's id of the song loaded
    private var key = ""         // the song's own id
    private var src = ""
    private var gain: Float = 1  // the song's own (Equalize volume)
    private var volume: Float = 1
    private var sleepFade: Float = 1
    private var rate: Float = 1
    private var wantPlay = false // play when ready: the page's play and pause
    private var ended = false
    private var repeatOne = false
    private var pendingSeek: Double?
    private var nextPressed = false
    private var failedTold = ""
    private var resumeAfterInterruption = false
    // The item `id` is: AVQueuePlayer may have moved past it (it failed) before this hears of it.
    private var itemNow: AVPlayerItem?

    // How long the song playing has been heard: playing time, not places.
    private var heardMs: Double = 0
    private var playingSince: Double?
    private var heardAway: [[String: Any]] = []
    private let heardFile = FlowPaths.files.appendingPathComponent("audio-heard.json")
    private let lastFile = FlowPaths.files.appendingPathComponent("audio-last.json")

    // The sleep timer: when it runs out (wall clock, ms; 0: none) and over how long it fades.
    private var sleepAt: Double = 0
    private var sleepFadeMs: Double = 10000
    private var sleepTimer: Timer?

    // Song Transition: its length (ms; 0: none), the tail playing the end of the
    // song before (made ready for tailFor, from tailFrom s), the song coming in
    // (fading up), and whether the move on is the transition's (told as "auto").
    private var transitionMs: Double = 0
    private var tail: AVPlayer?
    private var tailItemObservation: NSKeyValueObservation?
    private var tailBoost: Boost?
    private var tailFor = ""
    private var tailFrom: Double = 0
    private var tailLength: Double = 0
    private var tailGain: Float = 1
    private var tailReady = false
    private var tailPlaying = false
    private var crossStartSet = false
    private var crossGeneration = 0
    private var crossing = false
    private var crossTimer: Timer?
    private var fadeInId = ""
    private var fadeInMs: Double = 0
    private var fadeIn: Float = 1

    private var timeObserver: Any?
    private var observations: [NSKeyValueObservation] = []
    private var itemObservation: NSKeyValueObservation?
    private var artwork: (path: String, art: MPMediaItemArtwork)?
    private var waitingSince: Double?

    private override init() {
        super.init()
        heardAway = readJsonArray(heardFile)
        player.actionAtItemEnd = .pause
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, policy: .longFormAudio)
        } catch {
            FlowLog.i("audio session: \(error.localizedDescription)")
        }
        observations.append(player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.playingChanged() }
        })
        observations.append(player.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.currentChanged() }
        })
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) { [weak self] _ in
            guard let self = self, self.player.timeControlStatus == .playing else { return }
            self.checkTransition()
            self.tellState()
        }
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(itemEnded(_:)), name: .AVPlayerItemDidPlayToEndTime, object: nil)
        center.addObserver(self, selector: #selector(itemBroke(_:)), name: .AVPlayerItemFailedToPlayToEndTime, object: nil)
        center.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: session)
        center.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: session)
        setUpRemote()
        FlowLog.i("player ready")
    }

    // MARK: the page's operations

    /// Applies the page's operations in order (engine.js).
    func apply(_ ops: [[String: Any]]) {
        for op in ops {
            let name = op["op"] as? String ?? ""
            switch name {
            case "load": load(op)
            case "next": setNext(FlowPlayer.dicts(op["items"]), repeats: FlowPlayer.bool(op["repeat"]))
            case "sleep": setSleep(at: FlowPlayer.num(op["at"]) ?? 0, fade: FlowPlayer.num(op["fade"]) ?? 10000)
            case "transition":
                transitionMs = max(0, FlowPlayer.num(op["ms"]) ?? 0)
                if transitionMs == 0 { dropTail("transition off") }
            case "unload": unload()
            case "play": play()
            case "pause": pause("asked")
            case "seek": seek(FlowPlayer.num(op["t"]) ?? 0)
            case "rate": setRate(Float(FlowPlayer.num(op["rate"]) ?? 1))
            case "gain":
                gain = Float(FlowPlayer.num(op["gain"]) ?? 1)
                applyVolume()
            case "volume":
                volume = Float(FlowPlayer.num(op["volume"]) ?? 1)
                applyVolume()
            case "meta":
                if let item = player.currentItem, var tag = tags[ObjectIdentifier(item)] {
                    tag.meta = op["meta"] as? [String: Any]
                    tags[ObjectIdentifier(item)] = tag
                }
                updateNowPlaying()
            default:
                FlowLog.i("unknown operation \(name)")
            }
        }
    }

    private func load(_ op: [String: Any]) {
        let newSrc = op["src"] as? String ?? ""
        let play = FlowPlayer.bool(op["play"])
        let at = FlowPlayer.num(op["at"]) ?? 0
        _ = takeHeard()
        dropTail("another song")
        endFadeIn()
        player.removeAllItems()
        tags.removeAll()
        id = op["id"] as? String ?? ""
        key = op["key"] as? String ?? ""
        src = newSrc
        gain = Float(FlowPlayer.num(op["gain"]) ?? 1)
        ended = false
        failedTold = ""
        pendingSeek = at > 0 ? at : nil
        itemNow = nil
        StreamLoader.shared.fromPage(newSrc)
        setRate(1)
        if newSrc.isEmpty {
            wantPlay = false
            player.pause()
        } else if let item = makeItem(newSrc) {
            tags[ObjectIdentifier(item)] = Tag(id: id, key: key, gain: gain, src: newSrc, meta: op["meta"] as? [String: Any])
            player.insert(item, after: nil)
            itemNow = item
            watch(item)
            wantPlay = play
            if play { start() }
        } else {
            wantPlay = false
            FlowLog.i("load \(id): not an address: \(FlowPlayer.redact(newSrc))")
        }
        applyVolume()
        updateEnd()
        updateNowPlaying()
        FlowLog.i("load \(id) \(FlowPlayer.redact(newSrc))" + (play ? " playing" : ""))
    }

    /// The songs after the one playing, as the page's queue has them; those
    /// already in place stay. `repeats`: the song playing over and over instead.
    private func setNext(_ items: [[String: Any]], repeats: Bool) {
        repeatOne = repeats
        defer { updateEnd() }
        guard let current = player.currentItem, tags[ObjectIdentifier(current)] != nil else { return }
        let queued = Array(player.items().dropFirst())
        var keep = 0
        while keep < queued.count, keep < items.count, same(queued[keep], items[keep]) { keep += 1 }
        for item in queued[keep...] {
            player.remove(item)
            tags[ObjectIdentifier(item)] = nil
        }
        var after: AVPlayerItem = keep > 0 ? queued[keep - 1] : current
        for it in items[keep...] {
            let itemSrc = it["src"] as? String ?? ""
            StreamLoader.shared.fromPage(itemSrc)
            guard let item = makeItem(itemSrc), player.canInsert(item, after: after) else { continue }
            tags[ObjectIdentifier(item)] = Tag(id: it["id"] as? String ?? "", key: it["key"] as? String ?? "",
                                               gain: Float(FlowPlayer.num(it["gain"]) ?? 1), src: itemSrc,
                                               meta: it["meta"] as? [String: Any])
            player.insert(item, after: after)
            after = item
        }
        boostNext()
    }

    private func same(_ item: AVPlayerItem, _ it: [String: Any]) -> Bool {
        guard let tag = tags[ObjectIdentifier(item)] else { return false }
        return tag.key == (it["key"] as? String ?? "") && tag.src == (it["src"] as? String ?? "")
            && tag.gain == Float(FlowPlayer.num(it["gain"]) ?? 1)
    }

    private func unload() {
        _ = takeHeard()
        dropTail("unloaded")
        endFadeIn()
        player.removeAllItems()
        tags.removeAll()
        itemNow = nil
        src = ""
        wantPlay = false
        ended = false
        pendingSeek = nil
        updateNowPlaying()
    }

    func play() {
        guard !src.isEmpty else { return }
        // As an <audio> does: a song that failed is tried again, one that ended starts again.
        if player.currentItem == nil || player.currentItem?.status == .failed {
            reload()
        } else if ended {
            player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
        }
        ended = false
        wantPlay = true
        start()
        tellState()
        updateNowPlaying()
    }

    private func start() {
        do {
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            FlowLog.i("audio session not active: \(error.localizedDescription)")
        }
        player.defaultRate = rate
        player.play()
        FlowLog.i("play \(id) on \(FlowNativePlugin.outputNow().name)")
    }

    func pause(_ why: String) {
        let was = wantPlay
        wantPlay = false
        player.pause()
        dropTail("paused")
        if was { FlowLog.i("pause \(id) (\(why))") }
        tellState()
        updateNowPlaying()
    }

    private func seek(_ t: Double) {
        ended = false
        dropTail("seek")
        guard let item = player.currentItem, item.status == .readyToPlay else {
            pendingSeek = t
            return
        }
        player.seek(to: CMTime(seconds: max(0, t), preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            DispatchQueue.main.async {
                self?.tellState()
                self?.updateNowPlaying()
            }
        }
    }

    private func setRate(_ r: Float) {
        rate = r > 0 ? r : 1
        player.defaultRate = rate
        if player.rate != 0 { player.rate = rate }
    }

    /// The song loaded again from its address, and the songs after it as they were.
    private func reload() {
        let after = player.items().dropFirst().compactMap { tags[ObjectIdentifier($0)] }
        let meta = player.currentItem.flatMap { tags[ObjectIdentifier($0)]?.meta }
        let place = player.currentItem.map { $0.currentTime().seconds } ?? 0
        player.removeAllItems()
        tags.removeAll()
        failedTold = ""
        itemNow = nil
        guard let item = makeItem(src) else { return }
        tags[ObjectIdentifier(item)] = Tag(id: id, key: key, gain: gain, src: src, meta: meta)
        player.insert(item, after: nil)
        itemNow = item
        applyVolume()
        watch(item)
        if place.isFinite, place > 0 { pendingSeek = place }
        var last = item
        for tag in after {
            guard let next = makeItem(tag.src), player.canInsert(next, after: last) else { continue }
            tags[ObjectIdentifier(next)] = Tag(id: tag.id, key: tag.key, gain: tag.gain, src: tag.src, meta: tag.meta)
            player.insert(next, after: last)
            last = next
        }
        boostNext()
        updateEnd()
        FlowLog.i("reload \(id)")
    }

    /// A song's file (a path in Flow's storage) or stream (an address).
    private func makeItem(_ source: String) -> AVPlayerItem? {
        let asset: AVURLAsset
        if source.hasPrefix("/") {
            guard let file = FlowPaths.resolve(source) else { return nil }
            var options: [String: Any] = [:]
            // Ogg (Opus, Vorbis) as such: iOS goes by a file's type, which these names may not tell it.
            if ["opus", "ogg", "oga"].contains(file.pathExtension.lowercased()) {
                options[AVURLAssetOverrideMIMETypeKey] = "audio/ogg"
            }
            asset = AVURLAsset(url: file, options: options)
        } else {
            guard let streamed = StreamLoader.shared.asset(source) else { return nil }
            asset = streamed
        }
        let item = AVPlayerItem(asset: asset)
        item.audioTimePitchAlgorithm = .timeDomain
        return item
    }

    /// At a song's end the player moves on to the next one, or stays there (the last one, or Repeat).
    private func updateEnd() {
        player.actionAtItemEnd = !repeatOne && player.items().count > 1 ? .advance : .pause
    }

    /// The app's volume times the song's gain: down by the player's volume, up by its Boost.
    private func applyVolume() {
        player.volume = max(0, min(1, volume * sleepFade * fadeIn * min(1, gain)))
        if let item = itemNow, let tag = tags[ObjectIdentifier(item)] {
            if gain > 1 { tag.boost.attach(to: item) }
            tag.boost.gain = max(1, gain)
        }
    }

    /// The song after this one turned up by its own gain, should it have one
    /// over 1, ready for the move to it. Not the songs further on (about two
    /// hours of them): each would fetch its sound now.
    private func boostNext() {
        guard let next = player.items().dropFirst().first, let tag = tags[ObjectIdentifier(next)], tag.gain > 1 else { return }
        tag.boost.gain = tag.gain
        tag.boost.attach(to: next)
    }

    // MARK: what the player does

    /// The song's status from now on, and as it is: one that failed while it was
    /// only next in the queue is already failed.
    private func watch(_ item: AVPlayerItem) {
        itemObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            DispatchQueue.main.async { self?.statusChanged(item) }
        }
    }

    private func statusChanged(_ item: AVPlayerItem) {
        guard item === itemNow else { return }
        switch item.status {
        case .readyToPlay:
            if let t = pendingSeek {
                pendingSeek = nil
                seek(t)
            }
            tellState()
            updateNowPlaying()
        case .failed:
            failed(item, id, src)
        default:
            break
        }
    }

    private func playingChanged() {
        let now = ProcessInfo.processInfo.systemUptime
        let playing = player.timeControlStatus == .playing
        if playing, playingSince == nil { playingSince = now }
        if !playing, let since = playingSince {
            heardMs += (now - since) * 1000
            playingSince = nil
        }
        // For the log: a song that had to wait for its data (a slow or lost network).
        if player.timeControlStatus == .waitingToPlayAtSpecifiedRate && wantPlay {
            if waitingSince == nil { waitingSince = now }
        } else if let since = waitingSince {
            waitingSince = nil
            if now - since >= 1 {
                FlowLog.i(String(format: "waited %.1f s for data of %@", now - since, id) + (playing ? "" : " (then stopped)"))
            }
        }
        tellState()
        updateNowPlaying()
    }

    /// On to the next song by itself, or by Next on the lock screen.
    private func currentChanged() {
        // The song left could not be played (AVQueuePlayer moved past it): told first.
        if let left = itemNow, left !== player.currentItem, left.status == .failed {
            failed(left, id, src)
        }
        guard let item = player.currentItem, let tag = tags[ObjectIdentifier(item)] else { return }
        itemNow = item
        watch(item)
        guard tag.id != id else { return }
        let from = id
        let fromKey = key
        let heard = takeHeard()
        id = tag.id
        key = tag.key
        gain = tag.gain
        src = tag.src
        ended = false
        failedTold = ""
        let alive = Set(player.items().map { ObjectIdentifier($0) })
        tags = tags.filter { alive.contains($0.key) }
        // The song coming in by a transition fades up; any other cuts the tail.
        if !crossing {
            dropTail("next")
            fadeInId = ""
        }
        fadeIn = id == fadeInId ? 0 : 1
        applyVolume()
        boostNext()
        updateEnd()
        updateNowPlaying()
        let why = crossing || !nextPressed ? "auto" : "next"
        crossing = false
        nextPressed = false
        FlowLog.i("on to \(id) (\(why)), \(from) heard \(Int(heard)) s")
        if let e = events {
            e.onAdvance(from, id, key, heard, why)
        } else {
            away(fromKey, heard)
        }
        tellState()
    }

    @objc private func itemEnded(_ note: Notification) {
        DispatchQueue.main.async {
            guard let item = note.object as? AVPlayerItem, item === self.player.currentItem else { return }
            if self.repeatOne {
                // The same song again (Next still leaves it).
                let heard = self.takeHeard()
                self.player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
                if self.wantPlay { self.player.play() }
                FlowLog.i("again \(self.id) (repeat), heard \(Int(heard)) s")
                self.events?.onAdvance(self.id, self.id, self.key, heard, "repeat")
                return
            }
            // Moving on: told by currentChanged.
            if self.player.actionAtItemEnd == .advance && self.player.items().count > 1 { return }
            self.ended = true
            FlowLog.i("ended \(self.id)")
            if let e = self.events {
                e.onEnded(self.id)
            } else {
                self.away(self.key, self.takeHeard())
            }
            self.tellState()
            self.updateNowPlaying()
        }
    }

    @objc private func itemBroke(_ note: Notification) {
        DispatchQueue.main.async {
            guard let item = note.object as? AVPlayerItem, item === self.itemNow else { return }
            self.failed(item, self.id, self.src)
        }
    }

    /// A song that could not be played: the page hears it, with the server's
    /// answer when it refused it (StreamLoader), or that iOS cannot play the
    /// file. AVQueuePlayer moves on past it by itself. Past a refusal or such
    /// a file it plays on; a song the network did not bring (StreamLoader
    /// waited minutes for it) pauses it, so the songs after it are not each
    /// given up in turn.
    private func failed(_ item: AVPlayerItem, _ failedId: String, _ itemSrc: String) {
        guard failedTold != failedId else { return }
        failedTold = failedId
        let error = item.error as NSError?
        let under = error?.userInfo[NSUnderlyingErrorKey] as? NSError
        let message = error.map { "\($0.domain) \($0.code): \($0.localizedDescription)" } ?? "The song could not be played."
        let status = StreamLoader.shared.refusal(of: itemSrc)
        let unsupported = status == 0 && FlowPlayer.cannotPlay(error)
        FlowLog.i("error \(failedId) \(message)" + (under.map { " (\($0.domain) \($0.code))" } ?? "")
                  + (status > 0 ? " (\(status))" : "") + (unsupported ? ": iOS cannot play this file" : ""))
        // Paused, nobody is waiting for it: Play tries it again.
        guard wantPlay else {
            FlowLog.i("(paused: not told)")
            return
        }
        events?.onError(failedId, message, status, unsupported)
        if status == 0 && !unsupported {
            pause("not loaded")
        } else if item === player.currentItem {
            // Still on it (iOS 18 stays, iOS 26 moves on by itself): on to the next one, or stopped.
            if player.items().count > 1 {
                player.advanceToNextItem()
            } else {
                pause("could not play")
            }
        }
        tellState()
    }

    /// Whether an item's error says iOS cannot play the file itself (its kind,
    /// or it is broken), rather than that it could not get it.
    private static func cannotPlay(_ error: NSError?) -> Bool {
        guard let e = error else { return false }
        // File format not recognized, failed to parse, no decoder, not supported for the asset.
        if e.domain == AVFoundationErrorDomain && [-11828, -11829, -11833, -11838].contains(e.code) { return true }
        // "Operation Stopped" from the format reader (iOS 26 and an Ogg Vorbis file).
        if let under = e.userInfo[NSUnderlyingErrorKey] as? NSError, under.code == -12873 { return true }
        return false
    }

    @objc private func interrupted(_ note: Notification) {
        guard let info = note.userInfo, let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        DispatchQueue.main.async {
            switch type {
            case .began:
                self.resumeAfterInterruption = self.wantPlay
                if self.wantPlay { self.pause("interrupted") }
            case .ended:
                let options = AVAudioSession.InterruptionOptions(rawValue: info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
                if self.resumeAfterInterruption && options.contains(.shouldResume) {
                    FlowLog.i("interruption over: playing on")
                    self.play()
                }
                self.resumeAfterInterruption = false
            @unknown default:
                break
            }
        }
    }

    @objc private func routeChanged(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        DispatchQueue.main.async {
            // Headphones pulled out, a Bluetooth device gone: as any player, it pauses.
            if reason == .oldDeviceUnavailable && self.wantPlay { self.pause("headphones out") }
            FlowLog.i("sound to \(FlowNativePlugin.outputNow().name)")
        }
    }

    // MARK: Song Transition

    /// Checked while playing: the tail made ready a while before the transition
    /// starts, and its start set to the moment. None with Repeat, without a next
    /// song, or for a song too short (a transition is at most a third of it).
    private func checkTransition() {
        // Not while the tail still plays the end of the song before.
        if tailPlaying { return }
        guard transitionMs > 0, !crossStartSet, !repeatOne, player.items().count > 1 else { return }
        let d = duration()
        guard d > 0 else { return }
        let length = min(transitionMs / 1000, d / 3)
        guard length >= 0.2 else { return }
        let from = d - length
        let left = from - position()
        guard left <= 12 else { return }
        if tail == nil || tailFor != id || tailFrom != from {
            // Too late to make it ready: this one goes over without a transition.
            if left >= 1.5 { makeTail(from, length) }
            return
        }
        guard left <= 1.2 else { return }
        crossStartSet = true
        let generation = crossGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, left / Double(max(0.1, rate)))) { [weak self] in
            guard let self = self, self.crossGeneration == generation else { return }
            self.crossStart()
        }
    }

    /// The song playing again in the tail, ready (paused, silent) at the place its transition starts.
    private func makeTail(_ from: Double, _ length: Double) {
        dropTail(nil)
        guard let item = makeItem(src) else { return }
        let t = AVPlayer(playerItem: item)
        t.volume = 0
        t.actionAtItemEnd = .pause
        tail = t
        tailFor = id
        tailFrom = from
        tailLength = length
        tailGain = gain
        tailReady = false
        if gain > 1 {
            let b = Boost()
            b.gain = gain
            b.attach(to: item)
            tailBoost = b
        }
        let place = CMTime(seconds: from, preferredTimescale: 1000)
        tailItemObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self = self, self.tail === t, item.status == .readyToPlay, self.tailItemObservation != nil else { return }
                self.tailItemObservation = nil
                t.seek(to: place, toleranceBefore: .zero, toleranceAfter: .zero) { done in
                    DispatchQueue.main.async {
                        if done, self.tail === t { self.tailReady = true }
                    }
                }
            }
        }
        FlowLog.i(String(format: "transition of %@ made ready at %.1f s, %ld ms", id, from, Int(length * 1000)))
    }

    /// The moment: the tail plays the song's end on, and this player moves on to the next one, which fades up.
    private func crossStart() {
        crossStartSet = false
        guard let t = tail, tailFor == id, wantPlay, player.timeControlStatus == .playing, player.items().count > 1 else {
            dropTail("not playing on")
            return
        }
        guard tailReady else {
            dropTail("its song was not ready")
            return
        }
        // Where this player has got to, should the moment have come late.
        let at = position()
        if at > tailFrom + 0.15 { t.seek(to: CMTime(seconds: at, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) }
        t.volume = max(0, min(1, volume * sleepFade * min(1, tailGain)))
        t.playImmediately(atRate: rate)
        tailPlaying = true
        let next = player.items()[1]
        fadeInId = tags[ObjectIdentifier(next)]?.id ?? ""
        fadeInMs = tailLength * 1000
        crossing = true
        FlowLog.i("transition from \(id) to \(fadeInId)")
        // Silent until it fades up (currentChanged comes a moment later).
        fadeIn = 0
        applyVolume()
        player.advanceToNextItem()
        crossTimer?.invalidate()
        crossTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.crossTick() }
    }

    /// Twenty times a second during a transition: the tail down, the song coming in up, each by its own place.
    private func crossTick() {
        var going = false
        if let t = tail, tailPlaying {
            let p = min(1, max(0, (t.currentTime().seconds - tailFrom) / max(0.001, tailLength)))
            t.volume = max(0, min(1, volume * sleepFade * min(1, tailGain))) * Float(cos(p * .pi / 2))
            if p >= 1 || t.timeControlStatus == .paused {
                dropTail(nil)
            } else {
                going = true
            }
        }
        if !fadeInId.isEmpty {
            if id == fadeInId {
                let p = min(1, max(0, position()) / max(0.001, fadeInMs / 1000))
                fadeIn = Float(sin(p * .pi / 2))
                applyVolume()
                if p >= 1 { endFadeIn() } else { going = true }
            } else if crossing {
                // On its way in (currentChanged not yet).
                going = true
            }
        }
        if !going {
            crossTimer?.invalidate()
            crossTimer = nil
        }
    }

    /// The song coming in at its full volume (its transition done, or cut short).
    private func endFadeIn() {
        fadeInId = ""
        if fadeIn != 1 {
            fadeIn = 1
            applyVolume()
        }
    }

    /// No tail (any more): the end of the song before stops, or the transition is not to be (why: logged).
    private func dropTail(_ why: String?) {
        crossGeneration += 1
        crossStartSet = false
        guard let t = tail else { return }
        let playing = tailPlaying
        t.pause()
        t.replaceCurrentItem(with: nil)
        tail = nil
        tailItemObservation = nil
        tailBoost = nil
        tailFor = ""
        tailReady = false
        tailPlaying = false
        if let why = why { FlowLog.i("transition " + (playing ? "cut short" : "dropped") + " (\(why))") }
        if playing { endFadeIn() }
    }

    /// For the test runner: the transition and the boost as they are.
    func effectsNow() -> [String: Any] {
        let b = itemNow.flatMap { tags[ObjectIdentifier($0)]?.boost }
        return [
            "transitionMs": transitionMs, "tail": tail != nil, "tailReady": tailReady, "tailPlaying": tailPlaying,
            "tailVolume": Double(tail?.volume ?? 0), "fadeIn": Double(fadeIn), "volume": Double(player.volume),
            "gain": Double(gain), "boost": Double(b?.gain ?? 1), "peakIn": Double(b?.peakIn ?? 0), "peakOut": Double(b?.peakOut ?? 0),
        ]
    }

    // MARK: the server's token

    /// A Flow Server's address of a song's sound ("https://host/flow/api/songs/<id>/audio?t=..."): the server's, else "".
    static func baseOf(_ source: String) -> String {
        guard source.hasPrefix("http://") || source.hasPrefix("https://"), let r = source.range(of: "/api/songs/") else { return "" }
        return String(source[..<r.lowerBound])
    }

    static func tokenOf(_ source: String) -> String {
        guard source.hasPrefix("http") else { return "" }
        return URLComponents(string: source)?.queryItems?.first(where: { $0.name == "t" })?.value ?? ""
    }

    /// StreamLoader signed in again (the server had ended this app's session):
    /// SessionKeeper and the page take the new token over. Failing that, the
    /// song fails with 401 and the page signs in itself.
    func streamsSignedIn(_ r: ServerSignIn.Result) {
        guard let t = r.token else {
            FlowLog.i("could not sign in again: \(r.problem)")
            return
        }
        SessionKeeper.shared.signedIn(t)
        FlowLog.i("signed in again" + (r.profileOk ? "" : " (\(r.problem))"))
        // Without the profile the token is not the one the page signs in with: it signs in itself.
        if r.profileOk { events?.onSignedIn(t) }
    }

    /// A token SessionKeeper signed in for: the songs go with it, the page takes it over.
    func tookToken(_ t: String, profileOk: Bool) {
        StreamLoader.shared.use(t)
        if profileOk { events?.onSignedIn(t) }
    }

    /// Where the song loaded comes from (a file of Flow's, or an address without its token), for the test runner.
    func sourceNow() -> String {
        FlowPlayer.redact(src)
    }

    /// What SessionKeeper tells the server: the song loaded, whether it plays, where, how long, its names.
    func sessionNow() -> (key: String, playing: Bool, position: Double, duration: Double, title: String, artist: String)? {
        guard !key.isEmpty, let item = player.currentItem else { return nil }
        let meta = tags[ObjectIdentifier(item)]?.meta
        return (key, wantPlay && !ended, position(), max(0, duration()), meta?["title"] as? String ?? "", meta?["artist"] as? String ?? "")
    }

    // MARK: state

    private func duration() -> Double {
        guard let d = player.currentItem?.duration, d.isNumeric, d.seconds.isFinite, d.seconds > 0 else { return -1 }
        return d.seconds
    }

    private func position() -> Double {
        guard player.currentItem != nil else { return 0 }
        if ended {
            let d = duration()
            if d > 0 { return d }
        }
        let t = player.currentTime().seconds
        if !t.isFinite || t < 0 { return pendingSeek ?? 0 }
        return pendingSeek ?? t
    }

    private func playbackState() -> Int {
        guard let item = player.currentItem else { return St.idle }
        if ended { return St.ended }
        switch item.status {
        case .failed:
            return St.idle
        case .readyToPlay:
            return player.timeControlStatus == .waitingToPlayAtSpecifiedRate ? St.buffering : St.ready
        default:
            return St.buffering
        }
    }

    /// { id, key, pwr: play when ready, st: 1 idle 2 buffering 3 ready 4 ended,
    /// t, at (when t was read, wall clock ms), d (-1 unknown), rate, vol, songs
    /// (this one and those after it) }, as FlowPlayer.java's.
    func state() -> [String: Any] {
        [
            "id": id,
            "key": key,
            "pwr": wantPlay,
            "st": playbackState(),
            "t": position(),
            "at": Date().timeIntervalSince1970 * 1000,
            "d": duration(),
            "rate": Double(rate),
            "vol": Double(player.volume),
            "songs": player.items().count,
        ]
    }

    private func tellState() {
        events?.onState(state())
    }

    // MARK: listens

    private func heardSoFar() -> Double {
        heardMs + (playingSince.map { (ProcessInfo.processInfo.systemUptime - $0) * 1000 } ?? 0)
    }

    /// How long the song playing was heard, in seconds; counting starts again.
    private func takeHeard() -> Double {
        let total = heardSoFar()
        heardMs = 0
        if playingSince != nil { playingSince = ProcessInfo.processInfo.systemUptime }
        return total / 1000
    }

    /// A listen while there is no page to record it.
    private func away(_ songKey: String, _ heard: Double) {
        guard !songKey.isEmpty, heard >= 1 else { return }
        heardAway.append(["key": songKey, "heard": heard, "at": Date().timeIntervalSince1970 * 1000])
        writeJson(heardAway, heardFile)
    }

    /// A page starts: what is loaded (the state, how long its song has been
    /// heard), the listens kept while there was no page (now the page's), and
    /// with nothing loaded the song Flow was closed on (`last` { key, at, heard }).
    func attach() -> [String: Any] {
        var a: [String: Any] = ["state": state(), "heard": heardSoFar() / 1000, "away": heardAway, "play": false]
        if key.isEmpty, let data = try? Data(contentsOf: lastFile), let last = try? JSONSerialization.jsonObject(with: data) {
            a["last"] = last
        }
        FlowLog.i("page attached, " + (key.isEmpty ? "nothing loaded" : "\(id) loaded") + ", \(heardAway.count) listens kept")
        heardAway = []
        try? FileManager.default.removeItem(at: heardFile)
        try? FileManager.default.removeItem(at: lastFile)
        return a
    }

    /// Flow closed (swiped away): the music stops; its song, place and listen
    /// are kept for the next start.
    func letGo() {
        guard !key.isEmpty else { return }
        let last: [String: Any] = ["key": key, "at": position(), "heard": heardSoFar() / 1000]
        player.pause()
        if let data = try? JSONSerialization.data(withJSONObject: last) {
            try? data.write(to: lastFile, options: .atomic)
        }
    }

    private func readJsonArray(_ file: URL) -> [[String: Any]] {
        guard let data = try? Data(contentsOf: file), let list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
            return []
        }
        return list
    }

    private func writeJson(_ value: Any, _ file: URL) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        do {
            try data.write(to: file, options: .atomic)
        } catch {
            FlowLog.i("could not keep a listen: \(error.localizedDescription)")
        }
    }

    // MARK: the sleep timer

    private func setSleep(at: Double, fade: Double) {
        sleepAt = at
        sleepFadeMs = max(1, fade)
        sleepTimer?.invalidate()
        sleepTimer = nil
        if sleepAt > 0 {
            FlowLog.i("sleep timer: stops in \(Int(((sleepAt - Date().timeIntervalSince1970 * 1000) / 1000).rounded())) s")
            sleepCheck()
        } else if sleepFade != 1 {
            sleepFade = 1
            applyVolume()
        }
    }

    private func sleepCheck() {
        guard sleepAt > 0 else { return }
        let left = sleepAt - Date().timeIntervalSince1970 * 1000
        if left <= 0 {
            sleepAt = 0
            pause("sleep timer")
            sleepFade = 1
            applyVolume()
            FlowLog.i("sleep timer ran out: paused")
            return
        }
        let f: Float = left < sleepFadeMs ? Float(left / sleepFadeMs) : 1
        if f != sleepFade {
            sleepFade = f
            applyVolume()
        }
        // Rarely until the fade, then four times a second.
        let delay = left > sleepFadeMs + 1000 ? min(left - sleepFadeMs, 30000) : 250
        sleepTimer = Timer.scheduledTimer(withTimeInterval: delay / 1000, repeats: false) { [weak self] _ in
            self?.sleepCheck()
        }
    }

    // MARK: iOS's controls (lock screen, Control Center, headphones, the car)

    private func setUpRemote() {
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in
            guard let self = self, !self.src.isEmpty else { return .noSuchContent }
            self.play()
            return .success
        }
        c.pauseCommand.addTarget { [weak self] _ in
            self?.pause("lock screen")
            return .success
        }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self, !self.src.isEmpty else { return .noSuchContent }
            if self.wantPlay { self.pause("lock screen") } else { self.play() }
            return .success
        }
        c.nextTrackCommand.addTarget { [weak self] _ in
            self?.remoteNext() == true ? .success : .noSuchContent
        }
        c.previousTrackCommand.addTarget { [weak self] _ in
            guard let self = self, !self.src.isEmpty else { return .noSuchContent }
            // Into the song: back to its start; at its start: the song before (the page's).
            if self.position() > 3 || self.events == nil {
                self.seek(0)
            } else {
                self.events?.onPrevious()
            }
            return .success
        }
        c.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self = self, let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self.seek(e.positionTime)
            return .success
        }
    }

    /// Next on the lock screen, in Control Center, on headphones or in the car: on to the queue's next song.
    func remoteNext() -> Bool {
        guard player.items().count > 1 else { return false }
        nextPressed = true
        player.advanceToNextItem()
        if wantPlay { player.play() }
        return true
    }

    /// What the lock screen shows now, for the test runner.
    func nowPlayingNow() -> [String: Any] {
        let info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        return [
            "title": info[MPMediaItemPropertyTitle] as? String ?? "",
            "artist": info[MPMediaItemPropertyArtist] as? String ?? "",
            "duration": info[MPMediaItemPropertyPlaybackDuration] as? Double ?? 0,
            "elapsed": info[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double ?? 0,
            "rate": info[MPNowPlayingInfoPropertyPlaybackRate] as? Double ?? 0,
            "artwork": info[MPMediaItemPropertyArtwork] != nil,
        ]
    }

    /// What the lock screen and Control Center show: the song's names and cover, its place.
    private func updateNowPlaying() {
        let center = MPNowPlayingInfoCenter.default()
        guard !src.isEmpty, let item = player.currentItem else {
            center.nowPlayingInfo = nil
            return
        }
        let meta = tags[ObjectIdentifier(item)]?.meta
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: meta?["title"] as? String ?? "",
            MPMediaItemPropertyArtist: meta?["artist"] as? String ?? "",
            MPMediaItemPropertyAlbumTitle: meta?["album"] as? String ?? "",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position(),
            MPNowPlayingInfoPropertyPlaybackRate: player.timeControlStatus == .playing ? Double(rate) : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        let d = duration()
        if d > 0 { info[MPMediaItemPropertyPlaybackDuration] = d }
        if let art = artworkFor(meta?["artwork"] as? String) { info[MPMediaItemPropertyArtwork] = art }
        center.nowPlayingInfo = info
    }

    private func artworkFor(_ path: String?) -> MPMediaItemArtwork? {
        guard let path = path, !path.isEmpty else { return nil }
        if let a = artwork, a.path == path { return a.art }
        guard let file = FlowPaths.resolve(path), let image = UIImage(contentsOfFile: file.path) else { return nil }
        let art = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        artwork = (path, art)
        return art
    }

    // MARK: helpers

    static func num(_ v: Any?) -> Double? {
        if let n = v as? NSNumber { return n.doubleValue }
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        return nil
    }

    static func bool(_ v: Any?) -> Bool {
        if let b = v as? Bool { return b }
        if let n = v as? NSNumber { return n.boolValue }
        return false
    }

    static func dicts(_ v: Any?) -> [[String: Any]] {
        (v as? [Any] ?? []).compactMap { $0 as? [String: Any] }
    }

    /// An address without the server's token, for the log.
    static func redact(_ source: String) -> String {
        source.replacingOccurrences(of: "([?&]t=)[^&]*", with: "$1...", options: .regularExpression)
    }
}
