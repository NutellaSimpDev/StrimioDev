import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { resolveUnifiedPlayback } from '../src/unifiedContentResolver.js';
import catalogRouter, { seriesRouter } from './catalog.js';
import animeRouter from './providers/anime.js';
import { authorizePlayback, getAuthorizedSession, isHashAuthorized } from './sessionStore.js';
import { findSubtitle, hasSubtitleProvidersConfigured, subsDir } from './subtitles.js';
import {
  getMediaTracks,
  getTorrentStats,
  startTorrentDiscovery,
  streamEmbeddedSubtitle,
  streamTorrentFile,
  transcodeTorrentFile
} from './torrentEngine.js';
import type { ResolveResponse } from './types.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const defaultLanguages = (process.env.STRIMIO_LANGUAGES || 'lat,spa,eng')
  .split(',')
  .map((lang) => lang.trim())
  .filter(Boolean);

app.use(cors());
app.use(express.json());
app.use('/subtitles', express.static(subsDir, {
  setHeaders(response) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  }
}));
app.use(express.static('public'));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'strimio-local-streamer' });
});

app.use('/api/catalog', catalogRouter);
app.use('/api/series', seriesRouter);
app.use('/api/anime', animeRouter);

app.get('/api/resolve', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    const type = String(req.query.type || 'movie');
    const allowUnverified = req.query.allowUnverified === 'true' ||
      process.env.STRIMIO_ALLOW_UNVERIFIED === 'true';

    if (!id) {
      res.status(400).json({ error: 'Parametro id requerido. Ejemplo: /api/resolve?id=tt0063350&type=movie' });
      return;
    }

    const result = await resolveUnifiedPlayback({
      id,
      title: String(req.query.title || id),
      type,
      season: req.query.season ? Number(req.query.season) : undefined,
      episode: req.query.episode ? Number(req.query.episode) : undefined,
      torrentio: {
        providers: req.query.providers ? String(req.query.providers).split(',') : undefined,
        configPath: req.query.torrentioConfigPath ? String(req.query.torrentioConfigPath) : undefined,
        baseUrl: req.query.torrentioBaseUrl ? String(req.query.torrentioBaseUrl) : undefined,
        isAuthorizedStream: () => allowUnverified
      },
      annatar: {
        baseUrl: req.query.annatarBaseUrl ? String(req.query.annatarBaseUrl) : process.env.ANNATAR_BASE_URL,
        configPath: req.query.annatarConfig ? String(req.query.annatarConfig) : process.env.ANNATAR_CONFIG,
        limit: req.query.annatarLimit ? Number(req.query.annatarLimit) : undefined,
        timeout: req.query.annatarTimeout ? Number(req.query.annatarTimeout) : undefined,
        isAuthorizedStream: () => allowUnverified
      }
    }) as ResolveResponse;

    result.options
      .filter((option) => option.authorized && option.infoHash)
      .forEach((option) => authorizePlayback(option, id));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/stream/:infoHash', async (req, res) => {
  try {
    const infoHash = req.params.infoHash;
    const fileIdx = req.query.fileIdx ? Number(req.query.fileIdx) : 0;
    const audioIdx = req.query.audioIdx !== undefined ? Number(req.query.audioIdx) : undefined;

    if (!isHashAuthorized(infoHash, fileIdx)) {
      res.status(403).json({
        error: 'Hash no autorizado. Primero resuelve fuentes con /api/resolve y STRIMIO_ALLOW_UNVERIFIED=true o una allowlist real.'
      });
      return;
    }

    if (audioIdx !== undefined) {
      await transcodeTorrentFile(req, res, infoHash, fileIdx, audioIdx);
    } else {
      await streamTorrentFile(req, res, infoHash, fileIdx);
    }
  } catch (error) {
    if (!res.headersSent) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes('metadata del torrent') ? 504 : 500).json({ error: message });
    } else {
      res.end();
    }
  }
});

app.get('/api/transcode/:infoHash', async (req, res) => {
  try {
    const infoHash = req.params.infoHash;
    const fileIdx = req.query.fileIdx ? Number(req.query.fileIdx) : 0;
    const audioTrack = req.query.audioTrack ? Number(req.query.audioTrack) : 0;

    if (!isHashAuthorized(infoHash, fileIdx)) {
      res.status(403).json({ error: 'Hash no autorizado para transcodificacion.' });
      return;
    }

    await transcodeTorrentFile(req, res, infoHash, fileIdx, audioTrack);
  } catch (error) {
    if (!res.headersSent) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes('metadata del torrent') ? 504 : 500).json({ error: message });
    } else {
      res.end();
    }
  }
});

const tracksHandler = async (req: any, res: any) => {
  try {
    const infoHash = req.params.infoHash;
    const fileIdx = req.query.fileIdx ? Number(req.query.fileIdx) : 0;

    if (!isHashAuthorized(infoHash, fileIdx)) {
      res.status(403).json({ error: 'Hash no autorizado para inspeccionar pistas.' });
      return;
    }

    res.json(await getMediaTracks(infoHash, fileIdx));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
};

app.get('/api/tracks/:infoHash', tracksHandler);
app.get('/api/stream/tracks/:infoHash', tracksHandler);

app.get('/api/embedded-subtitles/:infoHash/:subtitleTrack.vtt', async (req, res) => {
  try {
    const infoHash = req.params.infoHash;
    const fileIdx = req.query.fileIdx ? Number(req.query.fileIdx) : 0;
    const subtitleTrack = Number(req.params.subtitleTrack);
    await streamEmbeddedSubtitle(req, res, infoHash, fileIdx, subtitleTrack);
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : String(error));
  }
});

app.get('/api/stream/stats/:infoHash', async (req, res) => {
  const infoHash = req.params.infoHash;
  const fileIdx = req.query.fileIdx ? Number(req.query.fileIdx) : 0;

  if (!isHashAuthorized(infoHash, fileIdx)) {
    res.status(403).json({ error: 'Hash no autorizado para consultar estadisticas.' });
    return;
  }

  await startTorrentDiscovery(infoHash, fileIdx);
  res.json(getTorrentStats(infoHash));
});

app.get('/api/subtitles', async (req, res) => {
  try {
    const imdbId = String(req.query.id || '');
    const lang = String(req.query.lang || defaultLanguages[0] || 'spa');
    const infoHash = req.query.infoHash ? String(req.query.infoHash) : '';
    const fileIdx = req.query.fileIdx ? Number(req.query.fileIdx) : 0;
    const type = String(req.query.type || 'movie');
    const season = req.query.season ? Number(req.query.season) : undefined;
    const episode = req.query.episode ? Number(req.query.episode) : undefined;
    const session = infoHash ? getAuthorizedSession(infoHash, fileIdx) : null;
    const filename = req.query.filename ? String(req.query.filename) : session?.filename;

    if (!imdbId) {
      res.status(400).json({ error: 'Parametro id requerido. Ejemplo: /api/subtitles?id=tt0063350&lang=spa' });
      return;
    }

    const subtitle = await findSubtitle({ imdbId, lang, filename, type, season, episode });
    if (!subtitle) {
      res.status(404).json({ error: 'No se encontraron subtitulos para esos parametros.' });
      return;
    }

    res.json(subtitle);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/subtitles/batch', async (req, res) => {
  const imdbId = String(req.query.id || '');
  const infoHash = req.query.infoHash ? String(req.query.infoHash) : '';
  const fileIdx = req.query.fileIdx ? Number(req.query.fileIdx) : 0;
  const type = String(req.query.type || 'movie');
  const season = req.query.season ? Number(req.query.season) : undefined;
  const episode = req.query.episode ? Number(req.query.episode) : undefined;
  const session = infoHash ? getAuthorizedSession(infoHash, fileIdx) : null;
  const filename = req.query.filename ? String(req.query.filename) : session?.filename;
  const languages = req.query.langs ? String(req.query.langs).split(',') : defaultLanguages;

  const settled = await Promise.allSettled(languages.map((lang) => findSubtitle({ imdbId, lang, filename, type, season, episode })));
  res.json({
    providersConfigured: hasSubtitleProvidersConfigured(),
    subtitles: settled.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []),
    errors: settled.flatMap((result) => result.status === 'rejected' ? [result.reason?.message || String(result.reason)] : [])
  });
});

app.listen(port, () => {
  console.log(`Strimio local streamer listo en http://localhost:${port}`);
  console.log(`Player: http://localhost:${port}/player.html`);
});

let lastKnownTorrentExceptionAt = 0;

process.on('uncaughtException', (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('reserve') || message.includes('missing')) {
    const now = Date.now();
    if (now - lastKnownTorrentExceptionAt > 5000) {
      lastKnownTorrentExceptionAt = now;
      console.error('[webtorrent warning]', message);
    }
    return;
  }

  console.error('[uncaughtException]', error);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message.includes('Writable stream closed prematurely')) return;
  console.error('[unhandledRejection]', reason);
});
