function extractQuality(stream) {
  const text = `${stream.title || ''} ${stream.name || ''} ${stream.behaviorHints?.filename || ''}`;
  const match = text.match(/(?:^|[^\d])(?<quality>4k|2160p|1440p|2k|1080p|720p|576p|480p|360p)(?:[^\d]|$)/i);

  if (!match?.groups?.quality) return 'UNKNOWN';
  return match.groups.quality.toUpperCase();
}

function qualityRank(quality) {
  return {
    '4K': 60,
    '2160P': 60,
    '1440P': 55,
    '2K': 55,
    '1080P': 50,
    '720P': 40,
    '576P': 35,
    '480P': 30,
    '360P': 20
  }[String(quality).toUpperCase()] || 0;
}

function detectSourceKind(stream) {
  if (stream.url) {
    if (/^magnet:/i.test(stream.url)) return 'magnet';
    return /^https?:\/\//i.test(stream.url) ? 'http' : 'direct';
  }
  if (stream.infoHash) return 'torrent';
  return 'metadata';
}

function normalizeFileIdx(stream) {
  if (Number.isInteger(stream.fileIdx)) return stream.fileIdx;
  if (Number.isInteger(Number(stream.fileIdx))) return Number(stream.fileIdx);
  return stream.infoHash ? 0 : null;
}

function normalizeStremioStream(stream, index, addonName, isAuthorizedStream) {
  const quality = extractQuality(stream);
  const authorized = Boolean(isAuthorizedStream?.(stream));
  const sourceKind = detectSourceKind(stream);
  
  // Extract infoHash if url is a magnet link
  let infoHash = stream.infoHash || null;
  if (!infoHash && stream.url && /^magnet:\?xt=urn:btih:([a-f0-9]{40})/i.test(stream.url)) {
    const match = stream.url.match(/btih:([a-f0-9]{40})/i);
    if (match) infoHash = match[1].toLowerCase();
  }

  return {
    id: `${addonName}-${infoHash || stream.url || index}`,
    provider: addonName,
    providerId: addonName,
    sourceKind,
    title: stream.title || stream.name || `${addonName} stream ${index + 1}`,
    name: stream.name || addonName,
    server: addonName,
    quality,
    rank: qualityRank(quality),
    availability: stream.behaviorHints?.bingeGroup || stream.behaviorHints?.filename || null,
    url: stream.url || null,
    infoHash,
    fileIdx: normalizeFileIdx(stream),
    headers: stream.headers || {},
    subtitles: stream.subtitles || [],
    sources: stream.sources || [],
    behaviorHints: stream.behaviorHints || {},
    authorized,
    blockedReason: authorized ? '' : 'Fuente no verificada.'
  };
}

export async function fetchGenericStremioStreams({
  addonUrl,
  addonName,
  id,
  type = 'movie',
  season,
  episode,
  fetchImpl = fetch,
  isAuthorizedStream = () => false
}) {
  if (!id || typeof id !== 'string') {
    throw new Error('El addon requiere un ID valido.');
  }

  const streamId = type === 'series'
    ? `${id}:${Number(season)}:${Number(episode)}`
    : id;

  const cleanAddonUrl = addonUrl.replace(/\/manifest\.json(?:\?.*)?$/i, '').replace(/\/$/, '');
  const url = `${cleanAddonUrl}/stream/${type}/${streamId}.json`;
  const host = new URL(url).host;

  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`Addon respondio ${response.status}.`);
    }

    const data = await response.json();
    const streams = Array.isArray(data.streams) ? data.streams : [];

    return streams
      .map((stream, index) => normalizeStremioStream(stream, index, addonName, isAuthorizedStream))
      .sort((a, b) => b.rank - a.rank);
  } catch (error) {
    const cause = error.cause?.code || error.cause?.message || error.message;
    throw new Error(`${addonName} no disponible en ${host}: ${cause}.`, { cause: error });
  }
}
