# Web Stream Video

A small self-hosted video streaming server and web player. Drop videos into `src/videos/` (sub-folders are fine) and watch them from any device on your network, including iPhone/iPad.

## Features

- **Library browser** – recursively scans `src/videos/`, groups by folder, natural sort (E2 before E10), search box
- **Media player UI** – play/pause, previous/next, ±10s skip, seek bar, volume, speed, loop, autoplay-next, fullscreen
- **Keyboard shortcuts** – `Space`/`K` play, `←`/`→` skip 10s, `N` next, `P` previous, `M` mute, `F` fullscreen, `C` cycle captions
- **Range streaming** – `.mp4`, `.webm`, `.mov`, etc. are streamed with HTTP range requests, so seeking is instant
- **On-the-fly MKV support** – `.mkv` files are repackaged with ffmpeg (H.264/AAC copied, other codecs re-encoded)
  - Chrome/Edge/Brave/Firefox: fragmented MP4 stream (seeking restarts the stream at the new time)
  - Safari/iOS: HLS, with native seeking
- **Captions menu** – embedded text subtitles (SRT/ASS/mov_text/WebVTT) are extracted and converted to WebVTT
- **External subtitle files** – put `.srt`, `.vtt`, `.ass` or `.ssa` files next to a video, named after it:
  `Movie.mkv` → `Movie.srt`, `Movie.en.srt`, `Movie.es.forced.srt`, `Movie.English.srt`.
  They appear in the CC menu marked "(file)". Non-UTF-8 files (e.g. Windows-1252) are handled.
- **Seek-bar preview thumbnails** – hover (or drag on touch) over the seek bar to see a frame and timestamp; a sprite sheet is generated once per video with ffmpeg and cached
- Remembers your last video, autoplay setting and caption language

## Requirements

- Node.js 18+
- No system ffmpeg needed – `ffmpeg-static` and `ffprobe-static` are bundled as dependencies

## Getting started

```bash
npm install
npm start          # or: npm run dev  (auto-restart with nodemon)
```

Open <http://localhost:3000>. To watch from another device, use your computer's LAN address, e.g. `http://192.168.x.x:3000`.

Put your videos in `src/videos/`:

```
src/videos/
├── movie.mp4
└── Some.Show.S01/
    ├── Some.Show.S01E01.mkv
    └── Some.Show.S01E02.mkv
```

The `src/videos/` contents are git-ignored.

## Configuration

Set in a `.env` file (optional):

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PORT`   | `3000`  | Port the server listens on |

## API

| Endpoint | Description |
| -------- | ----------- |
| `GET /api/videos` | List all videos (recursive) |
| `GET /api/info?path=…` | Duration, whether transcoded, subtitle tracks (embedded + external) |
| `GET /stream?path=…[&start=s]` | Stream a video (range requests; MKV via ffmpeg) |
| `GET /thumbs/sprite.jpg?path=…` | Thumbnail sprite sheet for seek-bar previews (generated on first request) |
| `GET /hls/stream.m3u8?path=…` | HLS playlist for Safari/iOS |
| `GET /subtitle?path=…&index=N[&start=s]` | One embedded subtitle track as WebVTT |
| `GET /subtitle?path=…&file=…[&start=s]` | One external subtitle file as WebVTT |

Paths are relative to `src/videos/` and are validated to stay inside it.

## Notes

- HLS segments are cached in the system temp folder and cleared on every server start. Thumbnail sprites are cached there too (small, kept between runs).
- Picture-based subtitles (PGS/DVD) can't be converted and are not listed.
- The server has no authentication – only expose it on a network you trust.
