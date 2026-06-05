const defaultTorrentioBaseUrl = 'https://torrentio.strem.fun';
const defaultProviders = ['yts', 'eztv', 'rarbg', '1337x'];
const defaultTorrentioConfigPath = 'providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy,magnetdl,horriblesubs,nyaasi,tokyotosho,anidex,nekobt,cinecalidad,mejortorrent,wolfmax4k,besttorrents,torrent9,ilcorsaronero|language=spanish,latino|qualityfilter=scr,cam,480p|limit=30';

function assertContentType(type) {
  if (!['movie', 'series'].includes(type)) {
    throw new Error('Torrentio type debe ser "movie" o "series".');
  }
}

function normalizeProviders(providers = defaultProviders) {
  if (!providers) return '';
  return providers
    .map((provider) => String(provider).trim())
    .filter(Boolean)
    .join(',');
}

function buildTorrentioStreamUrl({ id, type, season, episode, providers, configPath, baseUrl = defaultTorrentioBaseUrl }) {
  assertContentType(type);

  if (!id || typeof id !== 'string') {
    throw new Error('Torrentio necesita un IMDb ID valido, por ejemplo "tt1234567".');
  }

  if (!/^tt\d+$/i.test(id)) {
    throw new Error('Torrentio requiere IMDb ID. Resuelve strings de busqueda a IMDb antes de consultar streams.');
  }

  const streamId = type === 'series'
    ? `${id}:${Number(season)}:${Number(episode)}`
    : id;

  if (type === 'series' && (!Number.isInteger(Number(season)) || !Number.isInteger(Number(episode)))) {
    throw new Error('Las series necesitan season y episode numericos.');
  }

  const providerList = normalizeProviders(providers);
  const resolvedConfigPath = configPath || (providerList ? `providers=${providerList}` : '');
  const normalizedConfigPath = resolvedConfigPath ? `/${resolvedConfigPath.replace(/^\/|\/$/g, '')}` : '';
  return `${baseUrl.replace(/\/$/, '')}${normalizedConfigPath}/stream/${type}/${streamId}.json`;
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

function detectSourceKind(stream) {
  if (stream.url) return /^https?:\/\//i.test(stream.url) ? 'http' : 'direct';
  if (stream.infoHash) return 'torrent';
  return 'metadata';
}

function normalizeFileIdx(stream) {
  if (Number.isInteger(stream.fileIdx)) return stream.fileIdx;
  if (Number.isInteger(Number(stream.fileIdx))) return Number(stream.fileIdx);
  return stream.infoHash ? 0 : null;
}

function normalizeTorrentioStream(stream, index, isAuthorizedStream) {
  const quality = extractQuality(stream);
  const authorized = Boolean(isAuthorizedStream?.(stream));
  const sourceKind = detectSourceKind(stream);
  return {
    id: `torrentio-${stream.infoHash || stream.url || index}`,
    provider: 'torrentio',
    providerId: 'torrentio',
    sourceKind,
    title: stream.title || stream.name || `Torrentio stream ${index + 1}`,
    name: stream.name || 'Torrentio',
    server: 'Torrentio',
    quality,
    rank: qualityRank(quality),
    availability: stream.behaviorHints?.bingeGroup || stream.behaviorHints?.filename || null,
    url: stream.url || null,
    infoHash: stream.infoHash || null,
    fileIdx: normalizeFileIdx(stream),
    headers: {},
    subtitles: [],
    sources: stream.sources || [],
    behaviorHints: stream.behaviorHints || {},
    authorized,
    blockedReason: authorized ? '' : 'Fuente no verificada por SourceRegistry/allowlist.'
  };
}

export async function fetchTorrentioStreams(imdbId, type = 'movie', {
  season,
  episode,
  providers = null,
  configPath = defaultTorrentioConfigPath,
  baseUrl = defaultTorrentioBaseUrl,
  fetchImpl = fetch,
  isAuthorizedStream = () => false
} = {}) {
  const url = buildTorrentioStreamUrl({ id: imdbId, type, season, episode, providers, configPath, baseUrl });
  const host = new URL(url).host;
  let response;

  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (error) {
    const cause = error.cause?.code || error.cause?.message || error.message;
    throw new Error(`Torrentio no disponible en ${host}: ${cause}.`, { cause: error });
  }

  if (!response.ok) {
    throw new Error(`Torrentio respondio ${response.status}.`);
  }

  const data = await response.json();
  const streams = Array.isArray(data.streams) ? data.streams : [];

  return streams
    .map((stream, index) => normalizeTorrentioStream(stream, index, isAuthorizedStream))
    .sort((a, b) => b.rank - a.rank);
}

export async function getTorrentioStreams({
  id,
  type,
  season,
  episode,
  providers = defaultProviders,
  configPath = defaultTorrentioConfigPath,
  baseUrl = defaultTorrentioBaseUrl,
  fetchImpl = fetch,
  isAuthorizedStream = () => false
}) {
  return fetchTorrentioStreams(id, type, {
    season,
    episode,
    providers,
    configPath,
    baseUrl,
    fetchImpl,
    isAuthorizedStream
  });
}

export { buildTorrentioStreamUrl, defaultProviders, defaultTorrentioConfigPath, extractQuality };
