# Siphon

**Siphon any stream.** A Chrome / Brave extension that detects and downloads video streams from (almost) any site for offline, local playback.

Most pages hide their real video behind a player, a blob URL, or a manifest loaded over `fetch`/XHR. Siphon doesn't scrape the page and guess; it quietly watches the network, recognises the actual media, and gives you one click to pull it down.

---

## Features

- **Universal detection.** Passively sniffs network traffic per tab via `chrome.webRequest` and classifies media by both URL and `Content-Type`, so it catches streams no matter how the player loads them (`fetch`, XHR, `<video>`, MSE).
- **HLS, DASH and direct files.** Recognises HLS (`.m3u8`), DASH (`.mpd`) and direct media (`mp4`, `webm`, `mkv`, `mov`, `m4v`, `m4a`, `mp3`, ...).
- **One-click download.** HLS playlists are fetched, every segment is downloaded with bounded concurrency and retries, then assembled into a single file.
- **Live per-stream progress.** Each detected stream gets its own progress bar in the popup and the on-page overlay.
- **Premium UI.** A dark glassmorphism popup and an in-page Shadow-DOM overlay that is immune to the host page's styling.
- **Series bulk download.** On supported series pages, grab every episode in one go.
- **Advanced manual mode.** Paste a playlist URL directly, pick a time range, and download just that slice.

## Supported formats

| Kind | Extensions | Status |
|------|------------|--------|
| HLS  | `.m3u8`    | Full download + assembly |
| Direct file | `.mp4` `.webm` `.mkv` `.mov` `.m4a` `.mp3` ... | Full download |
| DASH | `.mpd`     | Detection only (download in progress) |

## Install (load unpacked)

Siphon isn't on the Chrome Web Store yet. To run it:

1. Clone or download this repo.
2. Open `chrome://extensions` (or `brave://extensions`).
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.
5. Pin Siphon to your toolbar.

## Usage

1. Open any page with a video and start playing it.
2. The Siphon toolbar icon shows a badge with the number of streams found.
3. Click the icon (or use the on-page launcher pill) to see every detected stream.
4. Hit **Download** on the one you want. Progress shows inline; the file saves to your Downloads folder.

HLS streams are saved as `.ts` (MPEG-TS) or `.mp4` when a fragmented-MP4 init segment is present. Play `.ts` files in VLC, or remux to MP4 with `ffmpeg -i in.ts -c copy out.mp4`.

### Advanced / manual mode

Expand **Advanced** in the popup to paste a playlist URL by hand, load it, select a start/end time range, name the file, and download only that interval.

## How it works

```
┌─────────────┐   webRequest    ┌──────────────┐   STREAMS_UPDATED   ┌───────────┐
│  web page   │ ───────────────▶│   detector   │ ───────────────────▶│  popup /  │
│ (any site)  │   m3u8/mpd/mp4  │ (background) │                     │  overlay  │
└─────────────┘                 └──────────────┘                     └─────┬─────┘
                                                                           │ DOWNLOAD_STREAM
                                                                           ▼
                                    ┌──────────────────────────────────────────────┐
                                    │ service worker: HLS loader -> segment manager  │
                                    │ -> download manager (concurrency, retries,     │
                                    │ pause/resume) -> assembler -> chrome.downloads │
                                    └──────────────────────────────────────────────┘
```

- **`src/background/detector.js`** — the network sniffer and per-tab stream registry.
- **`src/background/service-worker.js`** — message router and download orchestration.
- **`src/core/`** — `hls-parser`, `hls-loader`, `segment-manager`, `download-manager` (job state machine), `video-assembler`.
- **`src/content/content.js`** — the in-page Shadow-DOM overlay.
- **`src/popup/`** — the toolbar popup UI.
- **`src/shared/`** — message types and shared utilities.

## Development

```bash
# run the unit tests (HLS parser)
bun test tests/hls-parser.test.js
```

The core modules are plain ES modules with no build step; load the folder unpacked and iterate.

## Roadmap

- [ ] DASH (`.mpd`) download and muxing
- [ ] In-browser MP4 remux via `ffmpeg.wasm`
- [ ] Quality / variant selection for adaptive streams
- [ ] Resilience to MV3 service-worker suspension mid-download
- [ ] End-to-end browser test suite
- [ ] Chrome Web Store release

## Disclaimer

Siphon is a personal tool for saving media you have the right to download. Respect the terms of service and copyright of the sites you use it on. You are responsible for how you use it.

## License

MIT
