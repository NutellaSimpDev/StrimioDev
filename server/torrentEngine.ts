import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Request, Response } from 'express';
import mime from 'mime-types';
import WebTorrent from 'webtorrent';

const cacheDir = join(tmpdir(), 'strimio-dev-torrents');
const client = new WebTorrent({ maxConns: 150 });
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
  select?: () => void;
  deselect?: () => void;
  createReadStream: (range?: { start?: number; end?: number }) => NodeJS.ReadableStream;
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

export function getTorrentStats(infoHash: string) {
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
      ready: false
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

  return {
    active: true,
    progress: Number(progress.toFixed(2)),
    downloadSpeed: formatSpeed(downloadSpeedBytes),
    downloadSpeedBytes,
    numPeers: torrent.numPeers || 0,
    timeRemaining: formatTime(timeRemainingMs),
    timeRemainingMs,
    ready: torrent.ready,
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

async function probeFile(file: TorrentFileLike) {
  const input = file.createReadStream() as DestroyableReadable;
  const ffprobe = spawn('ffprobe', [
    '-v', 'error',
    '-analyzeduration', '2M',
    '-probesize', '2M',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-i', 'pipe:0'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => {
    try {
      input.unpipe(ffprobe.stdin);
    } catch (e) {}
    try {
      input.destroy();
    } catch (e) {}
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
    input.on('error', (err: any) => {
      if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
        console.error('ffprobe input stream error:', err);
      }
      reject(err);
    });
    ffprobe.stdin.on('error', (err: any) => {
      if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
        console.error('ffprobe stdin error:', err);
      }
      reject(err);
    });
    ffprobe.stdout.on('error', (err: any) => {
      if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
        console.error('ffprobe stdout error:', err);
      }
      reject(err);
    });

    ffprobe.on('error', reject);
    ffprobe.on('close', (code, signal) => {
      clearTimeout(timeout);
      try {
        input.unpipe(ffprobe.stdin);
      } catch (e) {}
      try {
        input.destroy();
      } catch (e) {}
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

    input.pipe(ffprobe.stdin);
  });
}

async function getOrProbeFile(infoHash: string, fileIdx: number, file: TorrentFileLike) {
  const cacheKey = `${infoHash}_${fileIdx}`;
  if (probeCache.has(cacheKey)) {
    return probeCache.get(cacheKey)!;
  }
  const promise = probeFile(file).catch((err) => {
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

  const probe = await getOrProbeFile(infoHash, fileIdx, file);
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

  res.status(200);
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const input = file.createReadStream() as DestroyableReadable;
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-map', `0:s:${Math.max(0, subtitleTrack)}?`,
    '-f', 'webvtt',
    'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let stderr = '';
  let clientClosed = false;
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
    }
  });

  input.pipe(ffmpeg.stdin);
  ffmpeg.stdout.pipe(res, { end: true });
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
    const stream = file.createReadStream();
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
  const stream = file.createReadStream({ start, end });
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
    try {
      session.input.unpipe(session.ffmpeg.stdin);
    } catch (e) {}
    try {
      session.input.destroy();
    } catch (e) {}
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

  const range = req.headers.range;
  let start = 0;
  let end = file.length - 1;
  let timeOffset = 0;

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      start = match[1] ? Number(match[1]) : 0;
      end = match[2] ? Number(match[2]) : file.length - 1;
    }
  }

  const sessionKey = `${infoHash}_${fileIdx}_${audioTrack}`;
  let session = transcodeSessions.get(sessionKey);

  // Check if we can reuse the existing FFmpeg process
  if (session && session.ffmpeg && !session.ffmpeg.killed) {
    const expectedNextByte = session.lastSeekBytes + session.lastBytesWritten;
    const gap = start - expectedNextByte;

    if (gap >= 0 && gap < 5 * 1024 * 1024) {
      // Continuation! Reuse existing FFmpeg process
      if (session.cleanupTimeout) {
        clearTimeout(session.cleanupTimeout);
        session.cleanupTimeout = undefined;
      }

      // Detach old listeners
      if (session.activeDataListener) {
        session.ffmpeg.stdout.removeListener('data', session.activeDataListener);
      }
      if (session.activeEndListener) {
        session.ffmpeg.stdout.removeListener('end', session.activeEndListener);
      }

      res.status(206);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Range', `bytes ${start}-${end}/${file.length}`);
      res.setHeader('Content-Length', end - start + 1);

      let skipped = 0;
      let bytesWritten = 0;
      const limit = end - start + 1;

      const onData = (chunk: Buffer) => {
        if (res.destroyed) return;

        let dataChunk = chunk;
        if (skipped < gap) {
          const needed = gap - skipped;
          if (chunk.length <= needed) {
            skipped += chunk.length;
            return;
          } else {
            dataChunk = chunk.subarray(needed);
            skipped = gap;
          }
        }

        const remaining = limit - bytesWritten;
        if (dataChunk.length >= remaining) {
          res.write(dataChunk.subarray(0, remaining));
          bytesWritten += remaining;
          session!.lastBytesWritten = start + bytesWritten - session!.lastSeekBytes;
          session!.ffmpeg.stdout.removeListener('data', onData);
          res.end();
        } else {
          res.write(dataChunk);
          bytesWritten += dataChunk.length;
          session!.lastBytesWritten = start + bytesWritten - session!.lastSeekBytes;
        }
      };

      const onEnd = () => {
        if (!res.destroyed) res.end();
      };

      session.activeResponse = res;
      session.activeDataListener = onData;
      session.activeEndListener = onEnd;

      session.ffmpeg.stdout.on('data', onData);
      session.ffmpeg.stdout.on('end', onEnd);

      const onClientClose = () => {
        if (session!.activeDataListener) {
          session!.ffmpeg.stdout.removeListener('data', session!.activeDataListener);
          session!.activeDataListener = undefined;
        }
        if (session!.activeEndListener) {
          session!.ffmpeg.stdout.removeListener('end', session!.activeEndListener);
          session!.activeEndListener = undefined;
        }
        session!.activeResponse = undefined;

        session!.cleanupTimeout = setTimeout(() => {
          realCleanup(sessionKey);
        }, 5000);
      };
      req.on('close', onClientClose);
      return;
    }
  }

  // If we cannot reuse, clean up old session before starting a new one
  if (session) {
    if (session.cleanupTimeout) clearTimeout(session.cleanupTimeout);
    realCleanup(sessionKey);
  }

  // Calculate timeOffset for new stream
  if (start > 0) {
    try {
      const probe = await getOrProbeFile(infoHash, fileIdx, file);
      const duration = parseFloat(probe.format?.duration || '0') || 0;
      if (duration > 0) {
        timeOffset = (start / file.length) * duration;
      } else {
        timeOffset = start / 250000;
      }
    } catch (e) {
      timeOffset = start / 250000;
    }
  }

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Strimio-Filename', encodeURIComponent(file.name));
  res.setHeader('X-Strimio-Transcoded', 'audio-aac');

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${file.length}`);
    res.setHeader('Content-Length', end - start + 1);
  } else {
    res.status(200);
    res.setHeader('Content-Length', file.length);
  }

  const input = file.createReadStream() as DestroyableReadable;
  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel', 'error',
    '-analyzeduration', '2M',
    '-probesize', '2M'
  ];

  if (timeOffset > 0) {
    ffmpegArgs.push('-ss', timeOffset.toFixed(2));
  }

  ffmpegArgs.push(
    '-i', 'pipe:0',
    '-map', '0:v:0',
    '-map', `0:a:${Math.max(0, audioTrack)}?`,
    '-sn',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1'
  );

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

  const newSession: TranscodeSession = {
    ffmpeg,
    input,
    lastSeekTime: timeOffset,
    lastSeekBytes: start,
    lastBytesWritten: 0
  };
  transcodeSessions.set(sessionKey, newSession);

  let stderr = '';
  ffmpeg.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  input.on('error', (err: any) => {
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET' && !err.message?.includes('closed before ending')) {
      console.error('transcode input stream error:', err);
    }
    realCleanup(sessionKey);
  });
  ffmpeg.stdin.on('error', (err: any) => {
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET' && !err.message?.includes('closed before ending')) {
      console.error('ffmpeg stdin error:', err);
    }
    realCleanup(sessionKey);
  });
  ffmpeg.stdout.on('error', (err: any) => {
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET' && !err.message?.includes('closed before ending')) {
      console.error('ffmpeg stdout error:', err);
    }
    realCleanup(sessionKey);
  });
  res.on('error', (err: any) => {
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      console.error('streaming response error:', err);
    }
  });

  ffmpeg.on('error', (error) => {
    realCleanup(sessionKey);
    if (!res.headersSent) res.status(500).json({ error: error.message });
    else res.destroy(error);
  });
  ffmpeg.on('close', (code) => {
    if (code && !res.destroyed && !res.headersSent) {
      res.destroy(new Error(stderr || `ffmpeg termino con codigo ${code}`));
    }
    realCleanup(sessionKey);
  });

  input.pipe(ffmpeg.stdin);

  let bytesWritten = 0;
  const limit = end - start + 1;

  const onData = (chunk: Buffer) => {
    if (res.destroyed) return;
    const remaining = limit - bytesWritten;
    if (chunk.length >= remaining) {
      res.write(chunk.subarray(0, remaining));
      bytesWritten += remaining;
      newSession.lastBytesWritten = start + bytesWritten - newSession.lastSeekBytes;
      ffmpeg.stdout.removeListener('data', onData);
      res.end();
    } else {
      res.write(chunk);
      bytesWritten += chunk.length;
      newSession.lastBytesWritten = start + bytesWritten - newSession.lastSeekBytes;
    }
  };

  const onEnd = () => {
    if (!res.destroyed) res.end();
  };

  newSession.activeResponse = res;
  newSession.activeDataListener = onData;
  newSession.activeEndListener = onEnd;

  ffmpeg.stdout.on('data', onData);
  ffmpeg.stdout.on('end', onEnd);

  const onClientClose = () => {
    if (newSession.activeDataListener) {
      ffmpeg.stdout.removeListener('data', newSession.activeDataListener);
      newSession.activeDataListener = undefined;
    }
    if (newSession.activeEndListener) {
      ffmpeg.stdout.removeListener('end', newSession.activeEndListener);
      newSession.activeEndListener = undefined;
    }
    newSession.activeResponse = undefined;

    newSession.cleanupTimeout = setTimeout(() => {
      realCleanup(sessionKey);
    }, 5000);
  };
  req.on('close', onClientClose);
}
