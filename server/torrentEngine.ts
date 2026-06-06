import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Request, Response } from 'express';
import mime from 'mime-types';
import WebTorrent from 'webtorrent';

const cacheDir = join(tmpdir(), 'strimio-dev-torrents');
const client = new WebTorrent({
  maxConns: 200,
  torrentPort: Number(process.env.TORRENT_PORT || 6881),
  dhtPort: Number(process.env.DHT_PORT || 6882),
  dht: true,
  natUpnp: true
});
(client as any).on('error', (err: any) => {
  console.error('[WebTorrent Client Error]', err.message || err);
});
const activeTorrents = new Map<string, TorrentLike>();
const probeCache = new Map<string, Promise<any>>();
const trackers = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.fastcast.nz',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'https://tracker.gbitt.info:443/announce'
];
const torrentDiagnostics = new Map<string, {
  lastError?: string;
  lastNoPeers?: string;
  lastWireAt?: number;
}>();
const videoEncoder = process.env.STRIMIO_VIDEO_ENCODER || 'h264_videotoolbox';
const videoBitrate = process.env.STRIMIO_VIDEO_BITRATE || '8000k';
const preserveHdr = process.env.STRIMIO_PRESERVE_HDR !== 'false';
const toneMapHdr = process.env.STRIMIO_TONEMAP_HDR === 'true';

interface TranscodeSession {
  ffmpeg: any;
  input: any;
  lastSeekTime: number;
  lastSeekBytes: number;
  lastBytesWritten: number;
  cleanupTimeout?: NodeJS.Timeout;
  activeResponse?: Response;
  activeDataListener?: (chunk: Buffer) => void;
  activeEndListener?: () => void;
}
const transcodeSessions = new Map<string, TranscodeSession>();

type TorrentFileLike = {
  name: string;
  path?: string;
  length: number;
  downloaded?: number;
  progress?: number;
  select?: () => void;
  deselect?: () => void;
  createReadStream: (range?: { start?: number; end?: number; highWaterMark?: number }) => NodeJS.ReadableStream;
};

type DestroyableReadable = NodeJS.ReadableStream & {
  destroy: () => void;
};

type MediaTrack = {
  index: number;
  streamIndex?: number;
  codec?: string;
  language?: string;
  title?: string;
  label: string;
  supported?: boolean;
};

type TorrentLike = {
  infoHash: string;
  files: TorrentFileLike[];
  ready: boolean;
  progress?: number;
  downloadSpeed?: number;
  numPeers?: number;
  timeRemaining?: number;
  on: {
    (event: 'error', callback: (error?: Error) => void): void;
    (event: 'ready', callback: () => void): void;
    (event: 'wire', callback: () => void): void;
    (event: 'noPeers', callback: (announceType?: string) => void): void;
  };
  removeListener?: (event: string, callback: (...args: any[]) => void) => void;
  destroy?: (cb?: (err?: Error) => void) => void;
};

function selectOnlyFile(torrent: TorrentLike, fileIdx: number) {
  return pickVideoFile(torrent.files, fileIdx);
}

function magnetFor(infoHash: string) {
  const trackerString = trackers.map((tracker) => `&tr=${encodeURIComponent(tracker)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash}${trackerString}`;
}

function isVideoFile(file: TorrentFileLike) {
  return /\.(mp4|mkv|avi|webm)$/i.test(file.name || file.path || '');
}

function pickVideoFile(files: TorrentFileLike[], fileIdx: number) {
  if (Number.isInteger(fileIdx) && fileIdx >= 0 && fileIdx < files.length) {
    return files[fileIdx];
  }

  const byExtension = files.find(isVideoFile);
  if (byExtension) return byExtension;

  if (!files.length) return null;

  return files.reduce((a, b) => a.length > b.length ? a : b);
}

function localFilePath(file: TorrentFileLike) {
  return join(cacheDir, file.path || file.name);
}

function waitForReady(torrent: TorrentLike, timeoutMs = 25000) {
  if (torrent.ready && torrent.files.length) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error?: Error) => {
      cleanup();
      reject(error || new Error('Torrent no disponible.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('No se obtuvo metadata del torrent a tiempo. Prueba otra calidad con mas peers.'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (typeof torrent.removeListener === 'function') {
        torrent.removeListener('ready', onReady);
        torrent.removeListener('error', onError);
      }
    };

    torrent.on('ready', onReady);
    torrent.on('error', onError);
  });
}

export async function getTorrent(infoHash: string) {
  await mkdir(cacheDir, { recursive: true });

  const existing = activeTorrents.get(infoHash);
  if (existing) {
    try {
      await waitForReady(existing);
      return existing;
    } catch (error) {
      activeTorrents.delete(infoHash);
      throw error;
    }
  }

  let torrent: TorrentLike;
  try {
    torrent = client.add(magnetFor(infoHash), { announce: trackers, path: cacheDir }) as TorrentLike;
    activeTorrents.set(infoHash, torrent);
  } catch (error) {
    throw new Error(`Error al agregar torrent: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await waitForReady(torrent);
    return torrent;
  } catch (error) {
    activeTorrents.delete(infoHash);
    try {
      if (typeof torrent.destroy === 'function') {
        torrent.destroy();
      }
    } catch (e) {}
    throw error;
  }
}

export async function startTorrentDiscovery(infoHash: string, fileIdx = 0) {
  await mkdir(cacheDir, { recursive: true });

  const existing = activeTorrents.get(infoHash);
  if (existing) {
    if (existing.ready) selectOnlyFile(existing, fileIdx);
    return existing;
  }

  torrentDiagnostics.set(infoHash, {});
  const torrent = client.add(magnetFor(infoHash), { announce: trackers, path: cacheDir }) as TorrentLike;
  activeTorrents.set(infoHash, torrent);
  torrent.on('wire', () => {
    torrentDiagnostics.set(infoHash, {
      ...torrentDiagnostics.get(infoHash),
      lastWireAt: Date.now()
    });
  });
  torrent.on('ready', () => {
    selectOnlyFile(torrent, fileIdx);
  });
  torrent.on('noPeers', (announceType?: string) => {
    torrentDiagnostics.set(infoHash, {
      ...torrentDiagnostics.get(infoHash),
      lastNoPeers: announceType || 'unknown'
    });
  });
  torrent.on('error', (error?: Error) => {
    torrentDiagnostics.set(infoHash, {
      ...torrentDiagnostics.get(infoHash),
      lastError: error?.message || 'unknown'
    });
    // Stats callers poll state; keep discovery non-blocking and avoid crashing the server.
  });
  return torrent;
}

function formatSpeed(bytesPerSecond = 0) {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

function formatBytes(bytes = 0) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function formatTime(milliseconds = 0) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 'calculando';
  const seconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

function isLikelyHdrVideo(fileName = '') {
  return /\b(HDR10\+?|HDR|DV|DOVI|Dolby\s*Vision|HLG|PQ|BT\.?2020|Rec\.?2020)\b/i.test(fileName);
}

function shouldPreserveHdr(fileName = '') {
  return preserveHdr && isLikelyHdrVideo(fileName);
}

function videoTranscodeArgs(fileName = '') {
  if (videoEncoder === 'copy' || shouldPreserveHdr(fileName)) {
    return ['-c:v', 'copy', '-tag:v', 'hvc1'];
  }

  const args: string[] = [];
  if (toneMapHdr && isLikelyHdrVideo(fileName)) {
    args.push(
      '-vf',
      process.env.STRIMIO_HDR_FILTER || 'tonemap=tonemap=hable:desat=0:peak=100,format=yuv420p'
    );
  }

  if (videoEncoder === 'libx264') {
    return [
      ...args,
      '-c:v', 'libx264',
      '-preset', process.env.STRIMIO_X264_PRESET || 'veryfast',
      '-tune', 'zerolatency',
      '-crf', process.env.STRIMIO_X264_CRF || '23',
      '-pix_fmt', 'yuv420p'
    ];
  }

  return [
    ...args,
    '-c:v', 'h264_videotoolbox',
    '-b:v', videoBitrate,
    '-allow_sw', '1',
    '-pix_fmt', 'yuv420p'
  ];
}

export async function cleanupTorrentTemp() {
  await rm(cacheDir, { recursive: true, force: true });
}

let shutdownStarted = false;

export async function shutdownTorrentEngine({ cleanupTemp = true } = {}) {
  if (shutdownStarted) return;
  shutdownStarted = true;

  for (const key of [...transcodeSessions.keys()]) {
    realCleanup(key);
  }

  await new Promise<void>((resolve) => {
    try {
      const destroyableClient = client as unknown as { destroy: (callback?: (error?: Error) => void) => void };
      destroyableClient.destroy((error?: Error) => {
        if (error) console.warn('[torrentEngine] Error cerrando WebTorrent:', error.message);
        resolve();
      });
    } catch (error) {
      console.warn('[torrentEngine] Error cerrando WebTorrent:', error instanceof Error ? error.message : String(error));
      resolve();
    }
  });

  activeTorrents.clear();
  probeCache.clear();

  if (cleanupTemp) {
    await cleanupTorrentTemp();
  }
}

export async function stopTorrent(infoHash: string) {
  const torrent = activeTorrents.get(infoHash);
  activeTorrents.delete(infoHash);
  torrentDiagnostics.delete(infoHash);
  for (const key of [...probeCache.keys()]) {
    if (key.startsWith(`${infoHash}_`)) probeCache.delete(key);
  }

  if (!torrent?.destroy) return;

  await new Promise<void>((resolve) => {
    try {
      torrent.destroy?.(() => resolve());
      setTimeout(resolve, 1200).unref();
    } catch {
      resolve();
    }
  });
}

export function getTorrentStats(infoHash: string, fileIdx = 0) {
  const torrent = activeTorrents.get(infoHash);

  if (!torrent) {
    return {
      active: false,
      progress: 0,
      downloadSpeed: '0 B/s',
      downloadSpeedBytes: 0,
      numPeers: 0,
      timeRemaining: 'calculando',
      timeRemainingMs: 0,
      ready: false,
      file: null
    };
  }

  let progress = 0;
  let downloadSpeedBytes = 0;
  let timeRemainingMs = 0;

  try {
    progress = Math.max(0, Math.min(100, (torrent.progress || 0) * 100));
    downloadSpeedBytes = torrent.downloadSpeed || 0;
    timeRemainingMs = torrent.timeRemaining || 0;
  } catch (error) {
    torrentDiagnostics.set(infoHash, {
      ...torrentDiagnostics.get(infoHash),
      lastError: error instanceof Error ? error.message : String(error)
    });
  }

  const selectedFile = torrent.ready ? selectOnlyFile(torrent, fileIdx) : null;
  const fileDownloaded = selectedFile
    ? Math.max(0, Math.min(selectedFile.length, selectedFile.downloaded ?? ((torrent.progress || 0) * selectedFile.length)))
    : 0;
  const fileProgress = selectedFile?.length
    ? Math.max(0, Math.min(100, (fileDownloaded / selectedFile.length) * 100))
    : 0;

  return {
    active: true,
    progress: Number(progress.toFixed(2)),
    downloadSpeed: formatSpeed(downloadSpeedBytes),
    downloadSpeedBytes,
    numPeers: torrent.numPeers || 0,
    timeRemaining: formatTime(timeRemainingMs),
    timeRemainingMs,
    ready: torrent.ready,
    file: selectedFile ? {
      name: selectedFile.name,
      length: selectedFile.length,
      downloaded: Math.round(fileDownloaded),
      progress: Number(fileProgress.toFixed(2)),
      size: formatBytes(selectedFile.length),
      downloadedSize: formatBytes(fileDownloaded)
    } : null,
    diagnostics: torrentDiagnostics.get(infoHash) || {}
  };
}

function labelForTrack(track: { tags?: { language?: string; title?: string }; codec_name?: string }, fallback: string) {
  const parts = [
    track.tags?.title,
    track.tags?.language,
    track.codec_name
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : fallback;
}

function isTextSubtitleCodec(codec?: string) {
  return /^(subrip|srt|ass|ssa|webvtt|mov_text)$/i.test(codec || '');
}

function parseSubtitleTimestamp(value: string) {
  const match = value.trim().match(/(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/);
  if (!match) return null;
  return (Number(match[1] || 0) * 3600) + (Number(match[2]) * 60) + Number(match[3]) + (Number(match[4]) / 1000);
}

function formatSubtitleTimestamp(totalSeconds: number) {
  const safe = Math.max(0, totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const millis = Math.floor((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function offsetVtt(vtt: string, offsetSeconds: number) {
  if (!offsetSeconds) return vtt;
  return vtt.split('\n').map((line) => {
    if (!line.includes('-->')) return line;
    const [startRaw, restRaw] = line.split('-->');
    const [endRaw, ...settings] = restRaw.trim().split(/\s+/);
    const start = parseSubtitleTimestamp(startRaw);
    const end = parseSubtitleTimestamp(endRaw);
    if (start === null || end === null || end <= offsetSeconds) return null;
    const suffix = settings.length ? ` ${settings.join(' ')}` : '';
    return `${formatSubtitleTimestamp(start - offsetSeconds)} --> ${formatSubtitleTimestamp(end - offsetSeconds)}${suffix}`;
  }).filter((line) => line !== null).join('\n');
}

async function probeFile(infoHash: string, fileIdx: number) {
  const port = process.env.PORT || 3000;
  const inputUrl = `http://127.0.0.1:${port}/api/stream/${infoHash}?fileIdx=${fileIdx}`;
  const ffprobe = spawn('ffprobe', [
    '-v', 'error',
    '-analyzeduration', '1M',
    '-probesize', '1M',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-i', inputUrl
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => {
    try {
      ffprobe.kill('SIGKILL');
    } catch (e) {}
  }, 20000);

  ffprobe.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  ffprobe.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise<{
    format?: {
      duration?: string;
    };
    streams?: Array<{
      index: number;
      codec_type?: string;
      codec_name?: string;
      tags?: { language?: string; title?: string };
    }>;
  }>((resolve, reject) => {
    ffprobe.on('error', reject);
    ffprobe.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code || signal) {
        console.warn(`[probeFile] ffprobe termino con codigo ${code} (senal: ${signal}). Stderr: ${stderr}`);
        reject(new Error(stderr || `ffprobe termino con codigo ${code} (senal: ${signal})`));
        return;
      }

      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function getOrProbeFile(infoHash: string, fileIdx: number) {
  const cacheKey = `${infoHash}_${fileIdx}`;
  if (probeCache.has(cacheKey)) {
    return probeCache.get(cacheKey)!;
  }
  const promise = probeFile(infoHash, fileIdx).catch((err) => {
    probeCache.delete(cacheKey);
    throw err;
  });
  probeCache.set(cacheKey, promise);
  setTimeout(() => {
    probeCache.delete(cacheKey);
  }, 3600000); // Expire probe cache after 1 hour to prevent memory leaks
  return promise;
}

export async function getMediaTracks(infoHash: string, fileIdx = 0) {
  const torrent = await getTorrent(infoHash);
  const file = selectOnlyFile(torrent, fileIdx);

  if (!file) {
    throw new Error('No se encontro archivo de video dentro del torrent.');
  }

  const probe = await getOrProbeFile(infoHash, fileIdx);
  let audioOrder = 0;
  let subtitleOrder = 0;

  const audio: MediaTrack[] = [];
  const subtitles: MediaTrack[] = [];

  for (const stream of probe.streams || []) {
    if (stream.codec_type === 'audio') {
      const index = audioOrder;
      audio.push({
        index,
        streamIndex: stream.index,
        codec: stream.codec_name,
        language: stream.tags?.language,
        title: stream.tags?.title,
        label: labelForTrack(stream, `Audio ${index + 1}`)
      });
      audioOrder += 1;
    }

    if (stream.codec_type === 'subtitle') {
      const index = subtitleOrder;
      subtitles.push({
        index,
        streamIndex: stream.index,
        codec: stream.codec_name,
        language: stream.tags?.language,
        title: stream.tags?.title,
        label: labelForTrack(stream, `Subtitulo ${index + 1}`),
        supported: isTextSubtitleCodec(stream.codec_name)
      });
      subtitleOrder += 1;
    }
  }

  const duration = parseFloat(probe.format?.duration || '0') || 0;

  return { filename: file.name, audio, subtitles, duration };
}

export async function streamEmbeddedSubtitle(
  req: Request,
  res: Response,
  infoHash: string,
  fileIdx = 0,
  subtitleTrack = 0
) {
  const torrent = await getTorrent(infoHash);
  const file = selectOnlyFile(torrent, fileIdx);

  if (!file) {
    res.status(404).send('No se encontro archivo de video dentro del torrent.');
    return;
  }

  const input = file.createReadStream() as DestroyableReadable;
  const offset = req.query.offset ? Number(req.query.offset) : 0;
  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0'
  ];

  if (Number.isFinite(offset) && offset > 0) {
    ffmpegArgs.push('-ss', String(offset));
  }

  ffmpegArgs.push(
    '-map', `0:s:${Math.max(0, subtitleTrack)}?`,
    '-f', 'webvtt',
    'pipe:1'
  );

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  let clientClosed = false;
  ffmpeg.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  ffmpeg.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  const cleanup = () => {
    if (clientClosed) return;
    clientClosed = true;
    try {
      input.unpipe(ffmpeg.stdin);
    } catch (e) {}
    try {
      input.destroy();
    } catch (e) {}
    try {
      ffmpeg.kill('SIGKILL');
    } catch (e) {}
  };

  input.on('error', (err: any) => {
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      console.error('subtitle input stream error:', err);
    }
    cleanup();
  });
  ffmpeg.stdin.on('error', (err: any) => {
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      console.error('ffmpeg subtitle stdin error:', err);
    }
    cleanup();
  });
  ffmpeg.stdout.on('error', (err: any) => {
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      console.error('ffmpeg subtitle stdout error:', err);
    }
    cleanup();
  });
  res.on('error', (err: any) => {
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      console.error('subtitle response error:', err);
    }
  });

  req.on('close', cleanup);
  ffmpeg.on('error', (error) => {
    cleanup();
    if (!res.headersSent) res.status(500).send(error.message);
    else res.destroy(error);
  });
  ffmpeg.on('close', (code) => {
    req.off('close', cleanup);
    try {
      input.destroy();
    } catch (e) {}
    if (clientClosed) return;
    if (code && !res.destroyed) {
      res.destroy(new Error(stderr || `ffmpeg termino con codigo ${code}`));
      return;
    }
    if (!res.destroyed) {
      res.status(200);
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(offsetVtt(stdout, Number.isFinite(offset) ? offset : 0));
    }
  });

  input.pipe(ffmpeg.stdin);
}

export async function streamTorrentFile(req: Request, res: Response, infoHash: string, fileIdx = 0) {
  const torrent = await getTorrent(infoHash);
  const file = selectOnlyFile(torrent, fileIdx);

  if (!file) {
    res.status(404).json({ error: 'No se encontro archivo de video dentro del torrent.' });
    return;
  }

  const range = req.headers.range;
  const contentType = mime.lookup(file.name) || 'application/octet-stream';

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Strimio-Filename', encodeURIComponent(file.name));

  res.on('error', (err: any) => {
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      console.error('stream response error:', err);
    }
  });

  if (!range) {
    res.setHeader('Content-Length', file.length);
    const stream = file.createReadStream({ highWaterMark: 5 * 1024 * 1024 });
    const cleanup = () => {
      try {
        (stream as any).destroy();
      } catch (e) {}
    };
    req.on('close', cleanup);
    res.on('finish', () => req.off('close', cleanup));
    stream.on('error', () => {});
    stream.pipe(res);
    return;
  }

  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    res.status(416).setHeader('Content-Range', `bytes */${file.length}`).end();
    return;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : file.length - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start >= file.length || end >= file.length || start > end) {
    res.status(416).setHeader('Content-Range', `bytes */${file.length}`).end();
    return;
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${file.length}`);
  res.setHeader('Content-Length', end - start + 1);
  const stream = file.createReadStream({ start, end, highWaterMark: 5 * 1024 * 1024 });
  const cleanup = () => {
    try {
      (stream as any).destroy();
    } catch (e) {}
  };
  req.on('close', cleanup);
  res.on('finish', () => req.off('close', cleanup));
  stream.on('error', () => {});
  stream.pipe(res);
}

function realCleanup(key: string) {
  const session = transcodeSessions.get(key);
  if (session) {
    transcodeSessions.delete(key);
    if (session.input) {
      try {
        session.input.unpipe(session.ffmpeg.stdin);
      } catch (e) {}
      try {
        session.input.destroy();
      } catch (e) {}
    }
    try {
      session.ffmpeg.kill('SIGKILL');
    } catch (e) {}
  }
}

export async function transcodeTorrentFile(req: Request, res: Response, infoHash: string, fileIdx = 0, audioTrack = 0) {
  const torrent = await getTorrent(infoHash);
  const file = selectOnlyFile(torrent, fileIdx);

  if (!file) {
    res.status(404).json({ error: 'No se encontro archivo de video dentro del torrent.' });
    return;
  }

  // Respond with 200 OK for progressive chunked MP4 stream (no ranges)
  res.status(200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Strimio-Filename', encodeURIComponent(file.name));
  const hdrPreserved = shouldPreserveHdr(file.name);
  res.setHeader('X-Strimio-Transcoded', videoEncoder === 'copy' || hdrPreserved ? 'video-copy+audio-aac' : `video-${videoEncoder}+audio-aac`);
  res.setHeader('X-Strimio-HDR', hdrPreserved ? 'preserve' : 'off');
  res.setHeader('X-Strimio-Tonemap', toneMapHdr && isLikelyHdrVideo(file.name) && !hdrPreserved ? 'hdr-to-sdr' : 'off');

  const startTime = req.query.startTime ? parseFloat(req.query.startTime as string) : 0;
  const canUseLocalFile = existsSync(localFilePath(file)) && (torrent.progress || 0) > 0.98;

  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel', 'error',
    '-fflags', '+genpts',
    '-drc_scale', '0',
    '-analyzeduration', '1M',
    '-probesize', '1M'
  ];

  const port = process.env.PORT || 3000;
  const inputUrl = `http://127.0.0.1:${port}/api/stream/${infoHash}?fileIdx=${fileIdx}`;

  if (!Number.isNaN(startTime) && startTime > 0) {
    ffmpegArgs.push('-ss', String(startTime));
  }

  if (canUseLocalFile) {
    ffmpegArgs.push('-i', localFilePath(file));
    res.setHeader('X-Strimio-Seek-Mode', 'local-file');
  } else {
    ffmpegArgs.push('-i', inputUrl);
    res.setHeader('X-Strimio-Seek-Mode', videoEncoder === 'copy' || hdrPreserved ? 'torrent-stream-video-copy' : 'torrent-stream-hw-transcode');
  }

  res.flushHeaders();

  ffmpegArgs.push(
    '-map', '0:v:0',
    '-map', `0:a:${Math.max(0, audioTrack)}?`,
    '-sn',
    ...videoTranscodeArgs(file.name),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2',
    '-af', 'aresample=async=1',
    '-avoid_negative_ts', 'make_zero',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1'
  );

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  ffmpeg.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  const cleanup = () => {
    try {
      ffmpeg.kill('SIGKILL');
    } catch (e) {}
  };

  req.on('close', cleanup);

  ffmpeg.stdout.on('error', (err: any) => {
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      console.error('ffmpeg stdout error:', err);
    }
    cleanup();
  });

  res.on('error', (err: any) => {
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      console.error('streaming response error:', err);
    }
    cleanup();
  });

  ffmpeg.on('error', (error) => {
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: error.message });
    else res.destroy(error);
  });

  ffmpeg.on('close', (code) => {
    req.off('close', cleanup);
    if (code && !res.destroyed && !res.headersSent) {
      res.destroy(new Error(stderr || `ffmpeg termino con codigo ${code}`));
    }
  });

  ffmpeg.stdout.pipe(res);
}
