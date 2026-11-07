require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const VIDEO_ROOT = path.join(__dirname, 'src', 'videos');

const mimeTypes = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', // browsers support MKV only if codecs are H.264/AAC (Chrome/Edge)
  '.ogv': 'video/ogg',
};

// Recursively collect video files, sorted naturally (E2 before E10).
function scanVideos(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanVideos(full));
    } else if (mimeTypes[path.extname(entry.name).toLowerCase()]) {
      const rel = path.relative(VIDEO_ROOT, full).split(path.sep).join('/');
      results.push({
        path: rel,
        name: path.parse(entry.name).name,
        folder: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
        size: fs.statSync(full).size,
      });
    }
  }
  return results;
}

// ---- ffmpeg (bundled binaries, falling back to system ones) ----
const { spawn, execFile } = require('child_process');
const FFMPEG = require('ffmpeg-static') || 'ffmpeg';
const FFPROBE = require('ffprobe-static').path || 'ffprobe';

// Containers browsers generally can't play natively -> remux/transcode on the fly.
const TRANSCODE_EXTS = new Set(['.mkv']);
const needsTranscode = (file) => TRANSCODE_EXTS.has(path.extname(file).toLowerCase());

const probeCache = new Map();
function probe(file) {
  if (probeCache.has(file)) return probeCache.get(file);
  const p = new Promise((resolve, reject) => {
    execFile(
      FFPROBE,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const info = JSON.parse(stdout);
        const v = info.streams.find((s) => s.codec_type === 'video');
        const a = info.streams.find((s) => s.codec_type === 'audio');
        // Only text-based subtitle codecs can be converted to WebVTT (not PGS/DVD bitmaps).
        const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
        const subtitles = info.streams
          .filter((s) => s.codec_type === 'subtitle')
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => TEXT_SUBS.has(s.codec_name))
          .map(({ s, i }) => ({
            index: i, // index among subtitle streams (for -map 0:s:i)
            lang: (s.tags && s.tags.language) || 'und',
            title: (s.tags && s.tags.title) || '',
            forced: !!(s.disposition && s.disposition.forced),
          }));
        resolve({
          subtitles,
          duration: parseFloat(info.format.duration) || 0,
          videoCodec: v && v.codec_name,
          videoPixFmt: v && v.pix_fmt,
          audioCodec: a && a.codec_name,
        });
      }
    );
  });
  p.catch(() => probeCache.delete(file));
  probeCache.set(file, p);
  return p;
}

// Resolve a client-supplied relative path safely inside VIDEO_ROOT.
function resolveVideo(rel) {
  if (typeof rel !== 'string' || !rel) return { status: 400, msg: 'Missing path' };
  const full = path.resolve(VIDEO_ROOT, rel);
  if (!full.startsWith(VIDEO_ROOT + path.sep)) return { status: 403, msg: 'Forbidden' };
  if (!mimeTypes[path.extname(full).toLowerCase()]) return { status: 415, msg: 'Unsupported type' };
  try {
    if (!fs.statSync(full).isFile()) throw new Error();
  } catch {
    return { status: 404, msg: 'Video not found' };
  }
  return { full };
}

app.get('/api/info', async (req, res) => {
  const r = resolveVideo(req.query.path);
  if (!r.full) return res.status(r.status).send(r.msg);
  try {
    const info = await probe(r.full);
    res.json({ duration: info.duration, transcoded: needsTranscode(r.full), subtitles: info.subtitles });
  } catch (err) {
    console.error(err);
    res.status(500).send('Probe failed');
  }
});

// Extract one embedded subtitle track as WebVTT. `start` shifts cue times so they
// line up with a transcoded stream that was restarted at that offset.
app.get('/subtitle', async (req, res) => {
  const r = resolveVideo(req.query.path);
  if (!r.full) return res.status(r.status).send(r.msg);
  const idx = parseInt(req.query.index, 10);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).send('Bad index');
  const start = Math.max(0, parseFloat(req.query.start) || 0);

  try {
    const info = await probe(r.full);
    if (!info.subtitles.some((s) => s.index === idx)) return res.status(404).send('No such subtitle');
  } catch (err) {
    return res.status(500).send('Probe failed');
  }

  const args = ['-v', 'error'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', r.full, '-map', `0:s:${idx}`, '-f', 'webvtt', 'pipe:1');
  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.stderr.on('data', (d) => console.error('[ffmpeg sub]', d.toString().trim()));
  ff.on('error', () => res.headersSent ? res.destroy() : res.status(500).send('ffmpeg failed'));
  res.set('Content-Type', 'text/vtt; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  ff.stdout.pipe(res);
  res.on('close', () => ff.kill('SIGKILL'));
});

// ---- HLS (for iOS/Safari, which can't play a piped MP4 stream) ----
// ffmpeg segments the file once into a temp cache; playlist/segments are served from there.
const os = require('os');
const crypto = require('crypto');
const HLS_ROOT = path.join(os.tmpdir(), 'stream-video-hls');
fs.rmSync(HLS_ROOT, { recursive: true, force: true }); // cache is rebuilt per server run
fs.mkdirSync(HLS_ROOT, { recursive: true });
const hlsJobs = new Map(); // key -> { dir, done, failed }

async function startHls(full) {
  const st = fs.statSync(full);
  const key = crypto.createHash('sha1').update(full + st.mtimeMs + st.size).digest('hex');
  if (hlsJobs.has(key)) return key;

  const info = await probe(full);
  const copyVideo = info.videoCodec === 'h264' && (!info.videoPixFmt || info.videoPixFmt === 'yuv420p');
  const copyAudio = info.audioCodec === 'aac';
  const dir = path.join(HLS_ROOT, key);
  fs.mkdirSync(dir, { recursive: true });

  // Copy mode finishes in seconds -> full VOD playlist (proper seek bar).
  // Re-encoding is slow -> "event" playlist so playback can begin while it runs.
  const args = ['-v', 'error', '-i', full, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
  args.push(...(copyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*6)']));
  args.push(...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k', '-ac', '2']));
  args.push('-f', 'hls', '-hls_time', '6', '-hls_list_size', '0',
    '-hls_playlist_type', copyVideo ? 'vod' : 'event',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'), path.join(dir, 'index.m3u8'));

  const job = { dir, done: false, failed: false, vod: copyVideo };
  hlsJobs.set(key, job);
  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  ff.stderr.on('data', (d) => console.error('[ffmpeg hls]', d.toString().trim()));
  ff.on('error', () => { job.failed = true; });
  ff.on('close', (code) => {
    if (code === 0) job.done = true; else job.failed = true;
    if (job.failed) hlsJobs.delete(key);
  });
  return key;
}

// Playlist entry point: starts the job, waits until playable, rewrites segment URLs.
app.get('/hls/stream.m3u8', async (req, res) => {
  const r = resolveVideo(req.query.path);
  if (!r.full) return res.status(r.status).send(r.msg);
  try {
    const key = await startHls(r.full);
    const job = hlsJobs.get(key);
    const playlist = path.join(job.dir, 'index.m3u8');
    for (let i = 0; i < 600; i++) { // up to ~2 min
      if (!hlsJobs.has(key) || job.failed) throw new Error('ffmpeg failed');
      if (job.vod ? job.done : fs.existsSync(playlist) && /seg\d+\.ts/.test(fs.readFileSync(playlist, 'utf8'))) break;
      await new Promise((ok) => setTimeout(ok, 200));
      if (res.destroyed) return;
    }
    const text = fs.readFileSync(playlist, 'utf8')
      .split('\n')
      .map((l) => (l && !l.startsWith('#') ? `/hls/${key}/${l}` : l))
      .join('\n');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store');
    res.send(text);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).send('HLS failed');
  }
});

app.get('/hls/:key/:file', (req, res) => {
  const { key, file } = req.params;
  if (!/^[a-f0-9]{40}$/.test(key) || !/^seg\d{5}\.ts$/.test(file)) return res.status(400).send('Bad request');
  const full = path.join(HLS_ROOT, key, file);
  if (!fs.existsSync(full)) return res.status(404).send('Not found');
  res.set('Content-Type', 'video/mp2t');
  res.sendFile(full);
});

// Fragmented MP4 over a pipe: copies H.264/AAC, re-encodes anything else.
async function streamTranscoded(req, res, full) {
  let info;
  try {
    info = await probe(full);
  } catch (err) {
    console.error(err);
    return res.status(500).send('Probe failed');
  }
  const start = Math.max(0, parseFloat(req.query.start) || 0);
  const copyVideo = info.videoCodec === 'h264' && (!info.videoPixFmt || info.videoPixFmt === 'yuv420p');
  const copyAudio = info.audioCodec === 'aac';

  const args = ['-v', 'error'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', full, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');
  args.push(...(copyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']));
  args.push(...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k', '-ac', '2']));
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');

  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.stderr.on('data', (d) => console.error('[ffmpeg]', d.toString().trim()));
  ff.on('error', (err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).send('ffmpeg failed to start');
    else res.destroy();
  });

  res.status(200);
  res.set('Content-Type', 'video/mp4');
  res.set('Cache-Control', 'no-store');
  ff.stdout.pipe(res);
  res.on('close', () => ff.kill('SIGKILL')); // client seeked/closed -> stop encoding
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

app.get('/api/videos', (req, res) => {
  const videos = scanVideos(VIDEO_ROOT).sort(
    (a, b) => collator.compare(a.folder, b.folder) || collator.compare(a.name, b.name)
  );
  res.json(videos);
});

// Stream a video by relative path, e.g. /stream?path=1/sample-files.mp4
app.get('/stream', (req, res) => {
  const r = resolveVideo(req.query.path);
  if (!r.full) return res.status(r.status).send(r.msg);
  const fullPath = r.full;

  if (needsTranscode(fullPath)) return streamTranscoded(req, res, fullPath);

  const contentType = mimeTypes[path.extname(fullPath).toLowerCase()];
  const fileSize = fs.statSync(fullPath).size;
  const range = req.headers.range;

  res.set('Accept-Ranges', 'bytes');
  res.set('Content-Type', contentType);

  if (!range) {
    res.set('Content-Length', fileSize);
    return fs.createReadStream(fullPath).pipe(res);
  }

  const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
  let start = parseInt(startStr, 10);
  let end = endStr ? parseInt(endStr, 10) : fileSize - 1;

  if (isNaN(start)) {
    // Suffix range "bytes=-500"
    start = fileSize - end;
    end = fileSize - 1;
  }
  end = Math.min(end, fileSize - 1);

  if (isNaN(start) || start < 0 || start >= fileSize || start > end) {
    res.set('Content-Range', `bytes */${fileSize}`);
    return res.status(416).end();
  }

  res.status(206);
  res.set('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  res.set('Content-Length', end - start + 1);

  const stream = fs.createReadStream(fullPath, { start, end });
  stream.on('error', (err) => {
    console.error(err);
    res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
