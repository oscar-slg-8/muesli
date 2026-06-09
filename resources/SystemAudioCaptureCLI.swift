// SystemAudioCaptureCLI.swift
// Captures system audio via CATapDescription (macOS 14.2+).
//
// WHY CATapDescription vs SCStream:
//   SCStream captures audio associated with a *display* — it misses audio that
//   meeting apps (Zoom, Teams, Meet) route directly to output hardware or virtual
//   devices (AirPods, Bluetooth, BlackHole…).
//   CATapDescription taps audio at the *process* level, before it's sent to any
//   device. It captures every audio-producing app regardless of output routing.
//   This is the approach used by Granola, Krisp, and similar native tools.
//
// Requires: Microphone permission (NOT Screen Recording).
// Usage: system-audio-capture --output /path/to/output.wav
// Stdout (newline-delimited JSON):
//   {"type":"status","event":"started"}
//   {"type":"stats","rms":0.0123}   (~85ms interval, used for VU-meter)

import Foundation
import AVFoundation
import CoreAudio

setbuf(stdout, nil)

@available(macOS 14.2, *)
class AudioCapture {
    private var engine = AVAudioEngine()
    private var tapID: AudioObjectID = kAudioObjectUnknown
    private var aggregateID: AudioObjectID = kAudioObjectUnknown
    private var audioFile: AVAudioFile?

    func start(outputPath: String) throws {
        // 1. Process tap covering ALL running audio-producing processes.
        //    Empty array = all processes (Zoom, Teams, Meet, Chrome, etc.)
        let desc = CATapDescription(stereoMixdownOfProcesses: [])
        desc.muteBehavior = .unmuted

        var status = AudioHardwareCreateProcessTap(desc, &tapID)
        guard status == noErr, tapID != kAudioObjectUnknown else {
            throw NSError(
                domain: NSOSStatusErrorDomain,
                code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateProcessTap failed: \(status)"]
            )
        }
        fputs("[SystemAudioCapture] Process tap created: \(tapID)\n", stderr)

        // 2. Read the tap's UID. On macOS 15 (Sequoia) un process tap ne peut PAS
        //    être utilisé directement comme périphérique d'entrée d'AVAudioEngine
        //    (cette voie échoue avec -10851 / kAudioUnitErr_InvalidPropertyValue).
        //    La méthode supportée : envelopper le tap dans un *aggregate device
        //    privé* et lire depuis celui-ci.
        var tapUID: CFString = "" as CFString
        var uidAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uidSize = UInt32(MemoryLayout<CFString>.size)
        status = withUnsafeMutablePointer(to: &tapUID) {
            AudioObjectGetPropertyData(tapID, &uidAddr, 0, nil, &uidSize, $0)
        }
        guard status == noErr else {
            throw NSError(
                domain: NSOSStatusErrorDomain, code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "Cannot read tap UID: \(status)"]
            )
        }

        // 3. Create a PRIVATE aggregate device that contains the tap.
        let aggUID = "com.muesli.systemcapture.\(UUID().uuidString)"
        let aggDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "Muesli System Capture",
            kAudioAggregateDeviceUIDKey as String: aggUID,
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceTapListKey as String: [
                [kAudioSubTapUIDKey as String: tapUID]
            ]
        ]
        status = AudioHardwareCreateAggregateDevice(aggDescription as CFDictionary, &aggregateID)
        guard status == noErr, aggregateID != kAudioObjectUnknown else {
            throw NSError(
                domain: NSOSStatusErrorDomain, code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateAggregateDevice failed: \(status)"]
            )
        }
        fputs("[SystemAudioCapture] Aggregate device created: \(aggregateID)\n", stderr)

        // 4. Point the AVAudioEngine input node at the aggregate device.
        var deviceID = aggregateID
        let setStatus = AudioUnitSetProperty(
            engine.inputNode.audioUnit!,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceID,
            UInt32(MemoryLayout.size(ofValue: deviceID))
        )
        guard setStatus == noErr else {
            throw NSError(
                domain: NSOSStatusErrorDomain, code: Int(setStatus),
                userInfo: [NSLocalizedDescriptionKey: "Cannot set input device to aggregate: \(setStatus)"]
            )
        }

        // 5. Determine source format from the (aggregate-backed) input node.
        let srcFormat = engine.inputNode.inputFormat(forBus: 0)
        let srcRate   = srcFormat.sampleRate > 0 ? srcFormat.sampleRate : 48_000.0
        fputs("[SystemAudioCapture] Source: \(srcRate) Hz, \(srcFormat.channelCount) ch\n", stderr)
        guard srcFormat.channelCount > 0 else {
            throw NSError(
                domain: "com.muesli.audio", code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Aggregate input returned 0 channels"]
            )
        }

        // 4. Build converter to PCM16 mono 16 kHz (Whisper's native format).
        let dstFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16_000,
            channels: 1,
            interleaved: true
        )!
        guard let converter = AVAudioConverter(from: srcFormat, to: dstFormat) else {
            throw NSError(
                domain: "com.muesli.audio",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Cannot build AVAudioConverter \(srcFormat) → \(dstFormat)"]
            )
        }

        // 5. Open output WAV file directly (no base64, no IPC).
        let outputURL = URL(fileURLWithPath: outputPath)
        audioFile = try AVAudioFile(
            forWriting: outputURL,
            settings: dstFormat.settings,
            commonFormat: .pcmFormatInt16,
            interleaved: true
        )
        fputs("[SystemAudioCapture] Writing to: \(outputPath)\n", stderr)

        // 6. Install tap: convert and write directly to WAV file.
        engine.inputNode.installTap(
            onBus: 0, bufferSize: 4_096, format: srcFormat
        ) { [weak self] srcBuf, _ in
            guard let self = self else { return }

            let dstFrameCount = AVAudioFrameCount(Double(srcBuf.frameLength) * 16_000.0 / srcRate)
            guard dstFrameCount > 0,
                  let dstBuf = AVAudioPCMBuffer(pcmFormat: dstFormat, frameCapacity: dstFrameCount)
            else { return }

            var inputConsumed = false
            let result = converter.convert(to: dstBuf, error: nil) { _, outStatus in
                guard !inputConsumed else { outStatus.pointee = .noDataNow; return nil }
                inputConsumed = true
                outStatus.pointee = .haveData
                return srcBuf
            }
            guard result != .error, dstBuf.frameLength > 0 else { return }

            // Write PCM16 directly to WAV file (zero-copy vs old base64 approach).
            do {
                try self.audioFile?.write(from: dstBuf)
            } catch {
                fputs("[SystemAudioCapture] Write error: \(error)\n", stderr)
            }

            // Emit RMS for renderer VU-meter (~85ms interval at 16kHz/4096 frames).
            if let int16Ptr = dstBuf.int16ChannelData?[0] {
                var sum: Double = 0
                let count = Int(dstBuf.frameLength)
                for i in 0..<count {
                    let s = Double(int16Ptr[i]) / 32768.0
                    sum += s * s
                }
                let rms = sqrt(sum / Double(count))
                print("{\"type\":\"stats\",\"rms\":\(String(format: "%.4f", rms))}")
            }
        }

        // 7. Start the engine.
        try engine.start()
        fputs("[SystemAudioCapture] Started (CATapDescription, all processes, \(srcRate) Hz → 16 kHz)\n", stderr)
        print("{\"type\":\"status\",\"event\":\"started\"}")
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        // Setting audioFile to nil triggers AVAudioFile deallocation which
        // finalizes the RIFF/WAV header (writes correct chunk sizes).
        audioFile = nil
        // Détruire l'aggregate device AVANT le tap.
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = kAudioObjectUnknown
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }
        fputs("[SystemAudioCapture] Stopped\n", stderr)
    }
}

// ── Entry point ──────────────────────────────────────────────────────────────

guard #available(macOS 14.2, *) else {
    fputs("[SystemAudioCapture] Requires macOS 14.2+\n", stderr)
    exit(1)
}

// Parse --output argument
var outputPath: String? = nil
var argIdx = 1
while argIdx < CommandLine.arguments.count {
    let arg = CommandLine.arguments[argIdx]
    if arg == "--output" && argIdx + 1 < CommandLine.arguments.count {
        outputPath = CommandLine.arguments[argIdx + 1]
        argIdx += 2
    } else {
        argIdx += 1
    }
}

guard let resolvedOutputPath = outputPath else {
    fputs("[SystemAudioCapture] Usage: system-audio-capture --output /path/to/output.wav\n", stderr)
    exit(1)
}

let capture = AudioCapture()

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)

let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSrc.setEventHandler { capture.stop(); exit(0) }
termSrc.resume()

let intSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intSrc.setEventHandler { capture.stop(); exit(0) }
intSrc.resume()

Task {
    do {
        try capture.start(outputPath: resolvedOutputPath)
    } catch {
        fputs("[SystemAudioCapture] Failed: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

RunLoop.main.run()
