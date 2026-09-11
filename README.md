# Dynamic Volume

Compressor-based browser volume boost. 

Currently available plugins are not compressor-based thus while they boost the volume, for high-dynamic videos like Nolan's movies it would be too loud at times. This extension solves that so me and my GF could watch The Dark Knight without bleeding ears.

Dynamic Volume is a dependency-free Chrome 116+ extension that makes tab audio more comfortable using dynamic-range compression, optional BS.1770-style automatic leveling, and linked-stereo sample-peak protection.

All processing happens locally. The extension has no host permissions, content scripts, network requests, analytics, remote code, voice recognition, or audio recording.

## Install unpacked

1. Open `chrome://extensions` in Chrome 116 or newer.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this repository directory.
4. Start audio in a normal web tab, open Dynamic Volume, and select **Enable**.

Chrome requires a user gesture for every tab capture. Once enabled, a tab keeps processing when the popup closes and across ordinary navigation until capture ends or the user disables it.

## Signal chain

```text
tabCapture MediaStream
  -> DynamicsCompressorNode
  -> optional Auto Level GainNode
  -> Output Trim GainNode
  -> linked-stereo sample-peak limiter AudioWorklet (-1 dBFS, 5 ms look-ahead)
  -> AudioContext destination
```

A parallel analysis branch applies the 48 kHz ITU-R BS.1770 K-weighting filters and measures 400 ms momentary and 3-second short-term loudness. The Auto Level controller defaults to a -18 LUFS target, a +/-1.5 LU deadband, -9/+9 dB gain bounds, 1 dB/s boost, 6 dB/s attenuation, and a -55 LUFS silence gate. It is disabled by default.

The Web Audio compressor includes standardized makeup gain. The extension therefore labels its manual final gain as **Output trim**, not makeup gain.

## Permissions

- `activeTab`: identify the tab the user explicitly chose.
- `tabCapture`: obtain that tab's mixed audio stream.
- `offscreen`: keep the Web Audio graph alive after the popup closes.
- `storage`: save one global versioned settings object locally.

No website-wide host permission is requested.

## Tests

Run the deterministic unit suite with Node 18 or newer:

```powershell
npm test
```

The tests cover settings validation, preset interpolation, dB conversion, K-weighted rolling windows, Auto Level bounds and silence behavior, limiter latency, linked-stereo gain, finite output, and the -1 dBFS sample ceiling.

For browser checks, serve the main page and cross-origin iframe on different ports in two terminals:

```powershell
# Terminal A
python -m http.server 8000 --directory test-page

# Terminal B
python -m http.server 8001 --directory test-page
```

Then open `http://127.0.0.1:8000`, start a signal, and exercise activation, presets, Auto Level, popup closure, multiple tabs, navigation, iframe audio, and rapid enable/disable cycles.

## Known limitations

- Chrome internal pages and the Chrome Web Store cannot be captured.
- Fullscreen behavior is controlled by Chrome while tab capture is active.
- DRM-protected services vary by platform, service, and Chrome configuration. Support is best-effort and is not promised. If an initially audible captured stream is silent, Dynamic Volume stops it after 3.5 seconds so native audio returns.
- The limiter constrains decoded sample peaks. It is not an oversampled true-peak limiter and makes no inter-sample-peak guarantee.
- The 48 kHz AudioContext is intentional so the published BS.1770 filter coefficients are used reproducibly.

## Manual release checklist

- Enable on YouTube and Twitch and confirm audio continues after the popup closes.
- Enable two tabs, verify both remain audible, then stop one without affecting the other.
- Confirm global setting changes reach every active graph without clicks.
- Close and reopen the popup; verify status, active count, and meters recover.
- Close or navigate an active tab and confirm its graph is removed.
- Exercise fullscreen and document the current Chrome behavior.
- Check any target DRM services without claiming compatibility from a single machine.
