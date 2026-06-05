const defaultAnnatarBaseUrl = 'http://localhost:8001';

function assertContentType(type) {
  if (!['movie', 'series'].includes(type)) {
    throw new Error('Annatar type debe ser "movie" o "series".');
  }
}

function normalizeBaseUrl(baseUrl = defaultAnnatarBaseUrl) {
  return String(baseUrl || defaultAnnatarBaseUrl).replace(/\/$/, '');
}

function buildAnnatarStreamId({ id, type, season, episode }) {
  assertContentType(type);

  if (!id || typeof id !== 'string' || !/^tt\d+$/i.test(id)) {
    throw new Error('Annatar necesita un IMDb ID valido, por ejemplo "tt1234567".');
  }

  const streamId = type === 'series'
    ? `${id}:${Number(season)}:${Number(episode)}`
    : id;

  if (type === 'series' && (!Number.isInteger(Number(season)) || !Number.isInteger(Number(episode)))) {
    throw new Error('Las series necesitan season y episode numericos para Annatar.');
  }

  return streamId;
}

function buildAnnatarStreamUrl({
  id,
  type,
  season,
  episode,
  baseUrl = defaultAnnatarBaseUrl,
  configPath
}) {
  const streamId = buildAnnatarStreamId({ id, type, season, episode });
  const base = normalizeBaseUrl(baseUrl);
  const encodedConfig = String(configPath || '').replace(/^\/+|\/+$/g, '');
  const configSegment = encodedConfig ? `/${encodedConfig}` : '';
  return `${base}${configSegment}/stream/${type}/${streamId}.json`;
}

function buildAnnatarSearchUrl({
  id,
  type,
  season,
  episode,
  baseUrl = defaultAnnatarBaseUrl,
  limit = 30,
  timeout = 6
}) {
  buildAnnatarStreamId({ id, type, season, episode });
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/search/imdb/${type}/${id}`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('timeout', String(timeout));
  if (type === 'series') {
    url.searchParams.set('season', String(Number(season)));
    url.searchParams.set('episode', String(Number(episode)));
  }
  return url.toString();
}

function buildAnnatarHashesUrl({
  id,
  type,
  season,
  episode,
  baseUrl = defaultAnnatarBaseUrl,
  limit = 30
}) {
  buildAnnatarStreamId({ id, type, season, episode });
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/v2/hashes/${id}`);
  url.searchParams.set('limit', String(limit));
  if (type === 'series') {
    url.searchParams.set('season', String(Number(season)));
    url.searchParams.set('episode', String(Number(episode)));
  }
  return url.toString();
}

function extractQuality(stream) {
  const text = `${stream.title || ''} ${stream.name || ''} ${stream.behaviorHints?.filename || ''}`;
  const match = text.match(/(?:^|[^\d])(?<quality>4k|2160p|1440p|1080p|720p|576p|480p|360p)(?:[^\d]|$)/i);
  if (!match?.groups?.quality) return 'UNKNOWN';
  return match.groups.quality.toUpperCase();
}

function qualityRank(quality) {
  return {
    '4K': 60,
    '2160P': 60,
    '1080P': 50,
    '720P': 40,
    '480P': 30,
    '360P': 20
  }[String(quality).toUpperCase()] || 0;
}

function parseMagnet(url) {
  if (!url || !/^magnet:/i.test(url)) return {};
  const params = new URLSearchParams(url.replace(/^magnet:\?/i, ''));
  const xt = params.get('xt') || '';
  const infoHash = xt.match(/urn:btih:([a-z0-9]+)/i)?.[1] || null;
  const fileIdx = params.get('fileIdx') || params.get('fileidx') || params.get('so');
  return {
    infoHash,
    fileIdx: Number.isInteger(Number(fileIdx)) ? Number(fileIdx) : null
  };
}

function detectSourceKind(stream, infoHash) {
  if (infoHash || stream.infoHash) return 'torrent';
  if (stream.url) return /^https?:\/\//i.test(stream.url) ? 'http' : 'direct';
  return 'metadata';
}

function normalizeFileIdx(stream, infoHash, magnetFileIdx) {
  if (Number.isInteger(stream.fileIdx)) return stream.fileIdx;
  if (Number.isInteger(Number(stream.fileIdx))) return Number(stream.fileIdx);
  if (Number.isInteger(magnetFileIdx)) return magnetFileIdx;
  return infoHash ? 0 : null;
}

function normalizeAnnatarStream(stream, index, isAuthorizedStream) {
  const quality = extractQuality(stream);
  const magnet = parseMagnet(stream.url);
  const infoHash = stream.infoHash || magnet.infoHash || null;
  const sourceKind = detectSourceKind(stream, infoHash);
  const url = sourceKind === 'torrent' ? null : (stream.url || null);
  const authorized = Boolean(isAuthorizedStream?.(stream));

  return {
    id: `annatar-${infoHash || url || index}`,
    provider: 'annatar',
    providerId: 'annatar',
    sourceKind,
    title: stream.title || stream.name || `Annatar stream ${index + 1}`,
    name: stream.name || 'Annatar',
    server: 'Annatar',
    quality,
    rank: qualityRank(quality) + 1,
    availability: stream.behaviorHints?.bingeGroup || stream.behaviorHints?.filename || null,
    url,
    infoHash,
    fileIdx: normalizeFileIdx(stream, infoHash, magnet.fileIdx),
    headers: {},
    subtitles: [],
    sources: stream.sources || [],
    behaviorHints: stream.behaviorHints || {},
    authorized,
    blockedReason: authorized ? '' : 'Fuente no verificada por SourceRegistry/allowlist.'
  };
}

function normalizeAnnatarMedia(media, index, isAuthorizedStream) {
  const infoHash = media.hash || media.infoHash || media.info_hash || null;
  const title = media.title || media.name || `Annatar hash ${index + 1}`;
  const quality = extractQuality({ title });
  const authorized = Boolean(isAuthorizedStream?.(media));

  return {
    id: `annatar-${infoHash || index}`,
    provider: 'annatar',
    providerId: 'annatar',
    sourceKind: 'torrent',
    title,
    name: 'Annatar',
    server: 'Annatar',
    quality,
    rank: qualityRank(quality) + 1,
    availability: null,
    url: null,
    infoHash,
    fileIdx: infoHash ? 0 : null,
    headers: {},
    subtitles: [],
    sources: [],
    behaviorHints: {},
    authorized,
    blockedReason: authorized ? '' : 'Fuente no verificada por SourceRegistry/allowlist.'
  };
}

async function fetchJson(url, fetchImpl) {
  const host = new URL(url).host;
  let response;

  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (error) {
    const cause = error.cause?.code || error.cause?.message || error.message;
    throw new Error(`Annatar no disponible en ${host}: ${cause}.`, { cause: error });
  }

  if (!response.ok) {
    throw new Error(`Annatar respondio ${response.status} en ${new URL(url).pathname}.`);
  }

  return response.json();
}

async function fetchAnnatarSearchStreams({
  imdbId,
  type,
  season,
  episode,
  baseUrl,
  limit,
  timeout,
  fetchImpl,
  isAuthorizedStream
}) {
  const searchUrl = buildAnnatarSearchUrl({ id: imdbId, type, season, episode, baseUrl, limit, timeout });
  const data = await fetchJson(searchUrl, fetchImpl);
  const media = Array.isArray(data.media) ? data.media : [];
  return media
    .map((item, index) => normalizeAnnatarMedia(item, index, isAuthorizedStream))
    .filter((item) => item.infoHash)
    .sort((a, b) => b.rank - a.rank);
}

async function fetchAnnatarHashStreams({
  imdbId,
  type,
  season,
  episode,
  baseUrl,
  limit,
  fetchImpl,
  isAuthorizedStream
}) {
  const hashesUrl = buildAnnatarHashesUrl({ id: imdbId, type, season, episode, baseUrl, limit });
  const data = await fetchJson(hashesUrl, fetchImpl);
  const hashes = Array.isArray(data.hashes) ? data.hashes : [];
  return hashes
    .map((hash, index) => normalizeAnnatarMedia({ hash, title: `Annatar ${hash}` }, index, isAuthorizedStream))
    .filter((item) => item.infoHash)
    .sort((a, b) => b.rank - a.rank);
}

export async function fetchAnnatarStreams(imdbId, type = 'movie', {
  season,
  episode,
  baseUrl = defaultAnnatarBaseUrl,
  configPath,
  limit = 30,
  timeout = 6,
  fetchImpl = fetch,
  isAuthorizedStream = () => false
} = {}) {
  const attempts = [];

  if (configPath) {
    attempts.push(async () => {
      const url = buildAnnatarStreamUrl({ id: imdbId, type, season, episode, baseUrl, configPath });
      const data = await fetchJson(url, fetchImpl);
      const streams = Array.isArray(data.streams) ? data.streams : [];
      return streams
        .map((stream, index) => normalizeAnnatarStream(stream, index, isAuthorizedStream))
        .sort((a, b) => b.rank - a.rank);
    });
  }

  attempts.push(
    () => fetchAnnatarSearchStreams({
      imdbId,
      type,
      season,
      episode,
      baseUrl,
      limit,
      timeout,
      fetchImpl,
      isAuthorizedStream
    }),
    () => fetchAnnatarHashStreams({
      imdbId,
      type,
      season,
      episode,
      baseUrl,
      limit,
      fetchImpl,
      isAuthorizedStream
    })
  );

  const errors = [];
  for (const attempt of attempts) {
    try {
      const streams = await attempt();
      if (streams.length) return streams;
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  if (errors.length) throw new Error(errors.join(' | '));
  return [];
}

export async function getAnnatarStreams({
  id,
  type,
  season,
  episode,
  baseUrl = defaultAnnatarBaseUrl,
  configPath,
  limit,
  timeout,
  fetchImpl = fetch,
  isAuthorizedStream = () => false
}) {
  return fetchAnnatarStreams(id, type, {
    season,
    episode,
    baseUrl,
    configPath,
    limit,
    timeout,
    fetchImpl,
    isAuthorizedStream
  });
}

export {
  buildAnnatarHashesUrl,
  buildAnnatarSearchUrl,
  buildAnnatarStreamUrl,
  defaultAnnatarBaseUrl
};
