function normalizeServerName(source) {
  return source.server || source.name || source.provider || source.host || 'Servidor anime';
}

function normalizeQuality(source) {
  const text = `${source.quality || ''} ${source.label || ''} ${source.url || ''}`.toLowerCase();
  const match = text.match(/\b(1080p|720p|480p|360p)\b/i);
  return match ? match[1].toUpperCase() : 'UNKNOWN';
}

function qualityRank(quality) {
  return {
    '1080P': 50,
    '720P': 40,
    '480P': 30,
    '360P': 20
  }[String(quality).toUpperCase()] || 0;
}

function normalizeAnimeSource(source, index, isAuthorizedSource) {
  const quality = normalizeQuality(source);
  const authorized = Boolean(isAuthorizedSource?.(source));
  const base = {
    id: `anicli-${source.id || source.url || index}`,
    provider: 'anicli',
    providerId: 'authorized_anime',
    sourceKind: 'direct',
    title: source.title || `${normalizeServerName(source)} ${quality}`,
    server: normalizeServerName(source),
    quality,
    rank: qualityRank(quality),
    authorized,
    blockedReason: authorized ? null : 'Fuente anime no verificada por SourceRegistry/allowlist.'
  };

  if (!authorized) return base;

  return {
    ...base,
    url: source.url,
    headers: source.headers || {},
    subtitles: source.subtitles || []
  };
}

async function fetchJson(fetchImpl, url) {
  let response;

  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (error) {
    const cause = error.cause?.code || error.cause?.message || error.message;
    throw new Error(`Anime API no disponible: ${cause}.`, { cause: error });
  }

  if (!response.ok) throw new Error(`Anime API respondio ${response.status}.`);
  return response.json();
}

function pickArray(data, keys) {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

export async function searchAnime({ title, apiBaseUrl, fetchImpl = fetch }) {
  if (!apiBaseUrl) {
    throw new Error('Configura apiBaseUrl para un backend anicli-compatible autorizado.');
  }

  const params = new URLSearchParams({ q: title });
  const data = await fetchJson(fetchImpl, `${apiBaseUrl.replace(/\/$/, '')}/search?${params}`);
  return pickArray(data, ['results', 'anime', 'items']).map((item) => ({
    id: item.id || item.slug || item.url || item.title,
    title: item.title || item.name,
    url: item.url || null
  }));
}

export async function getAnimeEpisodeSources({
  title,
  episode,
  apiBaseUrl,
  fetchImpl = fetch,
  isAuthorizedSource = () => false
}) {
  if (!title) throw new Error('El cliente anime necesita title.');
  if (!Number.isInteger(Number(episode))) throw new Error('El cliente anime necesita episode numerico.');
  if (!apiBaseUrl) throw new Error('Configura apiBaseUrl para un backend anicli-compatible autorizado.');

  const matches = await searchAnime({ title, apiBaseUrl, fetchImpl });
  const selected = matches[0];
  if (!selected) return [];

  const params = new URLSearchParams({
    animeId: selected.id,
    episode: String(episode)
  });
  const data = await fetchJson(fetchImpl, `${apiBaseUrl.replace(/\/$/, '')}/episode-sources?${params}`);
  const sources = pickArray(data, ['sources', 'streams', 'links']);

  return sources
    .map((source, index) => normalizeAnimeSource(source, index, isAuthorizedSource))
    .sort((a, b) => b.rank - a.rank);
}
