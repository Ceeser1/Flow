import AVFoundation
import MediaToolbox

/// Turns a song up: Equalize volume's gains over 1, which AVPlayer's volume
/// (at most 1) cannot give, as Android's LoudnessEnhancer does. An audio tap on
/// the song's sound multiplies it, and a soft limiter keeps its peaks under
/// full scale (a song is turned up because it is quiet: its peaks seldom get
/// there). Put on a song only once it is to be turned up.
final class Boost {
    /// The factor (read on the audio thread; a word-sized store).
    var gain: Float = 1 {
        didSet {
            if gain != oldValue {
                peakIn = 0
                peakOut = 0
            }
        }
    }
    // The loudest sample before and after (since the factor changed), for the test runner.
    var peakIn: Float = 0
    var peakOut: Float = 0
    // Whether the tap's sound is 32-bit float, the only kind it changes.
    fileprivate var float = false
    private var attached = false

    /// The item's sound through this from now on (once its track is known).
    func attach(to item: AVPlayerItem) {
        guard !attached else { return }
        attached = true
        let asset = item.asset
        Task {
            let tracks: [AVAssetTrack]
            do {
                tracks = try await asset.loadTracks(withMediaType: .audio)
            } catch {
                FlowLog.i("could not turn up: \(error.localizedDescription)")
                return
            }
            guard let track = tracks.first else {
                FlowLog.i("could not turn up: no audio track")
                return
            }
            await MainActor.run { self.install(track, on: item) }
        }
    }

    private func install(_ track: AVAssetTrack, on item: AVPlayerItem) {
        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: Unmanaged.passRetained(self).toOpaque(),
            init: boostInit, finalize: boostFinalize, prepare: boostPrepare, unprepare: nil, process: boostProcess)
        var tap: MTAudioProcessingTap?
        let status = MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PostEffects, &tap)
        guard status == noErr, let tap = tap else {
            Unmanaged<Boost>.fromOpaque(callbacks.clientInfo!).release()
            FlowLog.i("could not turn up: tap \(status)")
            return
        }
        let input = AVMutableAudioMixInputParameters(track: track)
        input.audioTapProcessor = tap
        let mix = AVMutableAudioMix()
        mix.inputParameters = [input]
        item.audioMix = mix
    }

    /// Full scale's last 1 dB bent softly: a peak turned up past it comes close to 1, never over.
    static func limit(_ x: Float) -> Float {
        let knee: Float = 0.89
        let a = abs(x)
        if a <= knee { return x }
        let over = (a - knee) / (1 - knee)
        let y = knee + (1 - knee) * over / (1 + over)
        return x < 0 ? -y : y
    }
}

private func boostOf(_ tap: MTAudioProcessingTap) -> Boost {
    Unmanaged<Boost>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
}

private let boostInit: MTAudioProcessingTapInitCallback = { _, clientInfo, storage in
    storage.pointee = clientInfo
}

private let boostFinalize: MTAudioProcessingTapFinalizeCallback = { tap in
    Unmanaged<Boost>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release()
}

private let boostPrepare: MTAudioProcessingTapPrepareCallback = { tap, _, format in
    let f = format.pointee
    boostOf(tap).float = f.mFormatID == kAudioFormatLinearPCM && (f.mFormatFlags & kAudioFormatFlagIsFloat) != 0 && f.mBitsPerChannel == 32
}

private let boostProcess: MTAudioProcessingTapProcessCallback = { tap, frames, _, buffers, framesOut, flagsOut in
    guard MTAudioProcessingTapGetSourceAudio(tap, frames, buffers, flagsOut, nil, framesOut) == noErr else { return }
    let boost = boostOf(tap)
    let g = boost.gain
    guard boost.float, g > 1.0001 else { return }
    var peakIn: Float = 0
    var peakOut: Float = 0
    for buffer in UnsafeMutableAudioBufferListPointer(buffers) {
        guard let data = buffer.mData else { continue }
        let samples = data.assumingMemoryBound(to: Float.self)
        for i in 0..<(Int(buffer.mDataByteSize) / MemoryLayout<Float>.size) {
            let x = samples[i]
            let y = Boost.limit(x * g)
            samples[i] = y
            peakIn = max(peakIn, abs(x))
            peakOut = max(peakOut, abs(y))
        }
    }
    boost.peakIn = max(boost.peakIn * 0.999, peakIn)
    boost.peakOut = max(boost.peakOut * 0.999, peakOut)
}
