import { getAnimeEpisodeSources } from './clients/anicliClient.js';
import { getAnnatarStreams } from './clients/annatarClient.js';
import { getTorrentioStreams } from './clients/torrentioClient.js';
import { fetchGenericStremioStreams } from './clients/genericStremioClient.js';

function normalizeStremioAddonUrl(input) {
  return String(input || '')
    .trim()
    .replace(/^stremio:\/\//i, 'https://')
    .replace(/\/manifest\.json(?:\?.*)?$/i, '')
    .replace(/\/+$/, '');
}

function configuredStreamAddons(addonsValue = '') {
  return String(addonsValue || '')
    .split(',')
    .map(normalizeStremioAddonUrl)
    .filter(Boolean)
    .map((url) => ({
      name: new URL(url).hostname.split('.')[0],
      url
    }));
}

function getLanguageScore(title) {
  const normalized = String(title || '').toLowerCase();
  
  // Latino / Latin American Spanish flags and text
  const isLatino = 
    /\b(latino|lat|la|lats)\b/i.test(normalized) ||
    /latin\s*american/i.test(normalized) ||
    /dual\s*lat/i.test(normalized) ||
    /audio\s*lat/i.test(normalized) ||
    /🇲🇽|🇨🇱|🇨🇴|🇵🇪|🇦🇷|🇻🇪|🇧🇴|🇺🇾|🇵🇾|🇨🇷|🇵🇦|🇬🇹|🇸🇻|🇭🇳|🇳🇮|🇨🇺|🇩🇴|🇪🇨/.test(normalized);

  if (isLatino) {
    return 3;
  }

  // Spain Spanish / Castellano / SPA
  const isSpanish = 
    /\b(español|espanol|castellano|spa|esp|cast|es)\b/i.test(normalized) ||
    /spanish/i.test(normalized) ||
    /dual\s*esp/i.test(normalized) ||
    /audio\s*esp/i.test(normalized) ||
    /🇪🇸/.test(normalized);

  if (isSpanish) {
    return 2;
  }

  // English
  const isEnglish = 
    /\b(english|eng|en)\b/i.test(normalized) ||
    /🇬🇧|🇺🇸|🇨🇦|🇦🇺|🇳🇿|🇮🇪/.test(normalized);

  // Fallback / other languages
  const isOtherLanguage =
    /\b(french|fr|fra|italian|ita|portuguese|por|pt|german|ger|de|russian|rus|ru|multi)\b/i.test(normalized) ||
    /🇫🇷|🇮🇹|🇵🇹|🇧🇷|🇩🇪|🇷🇺/.test(normalized);

  if (isEnglish) {
    return 1;
  }
  
  if (isOtherLanguage) {
    return 0;
  }

  return 1;
}

function sortPlaybackOptions(a, b) {
  if (Number(b.authorized) !== Number(a.authorized)) return Number(b.authorized) - Number(a.authorized);
  
  const scoreA = (a.rank || 0) + (getLanguageScore(a.title) * 12);
  const scoreB = (b.rank || 0) + (getLanguageScore(b.title) * 12);
  
  if (scoreB !== scoreA) return scoreB - scoreA;
  if (b.rank !== a.rank) return b.rank - a.rank;
  
  return a.provider.localeCompare(b.provider);
}

function toPlayableOption(source) {
  return {
    provider: source.provider,
    providerId: source.providerId,
    sourceKind: source.sourceKind,
    title: source.title,
    quality: source.quality,
    server: source.server || source.name || null,
    url: source.url || null,
    infoHash: source.infoHash || null,
    fileIdx: source.fileIdx ?? null,
    headers: source.headers || {},
    subtitles: source.subtitles || [],
    authorized: source.authorized,
    blockedReason: source.blockedReason ?? null
  };
}

export async function resolveUnifiedPlayback({
  id,
  title,
  type = 'movie',
  season,
  episode,
  animeTitle = title,
  animeEpisode = episode,
  torrentio = {},
  annatar = {},
  anicli = {},
  stremio = {},
  fetchImpl = fetch
}) {
  const tasks = [];

  const streamAddons = configuredStreamAddons(stremio.streamAddons);

  if (id) {
    tasks.push(getTorrentioStreams({
      id,
      type,
      season,
      episode,
      fetchImpl,
      ...torrentio
    }));

    if (annatar.baseUrl) {
      tasks.push(getAnnatarStreams({
        id,
        type,
        season,
        episode,
        fetchImpl,
        ...annatar
      }));
    }

    streamAddons.forEach((addon) => {
      tasks.push(fetchGenericStremioStreams({
        addonUrl: addon.url,
        addonName: addon.name,
        id,
        type,
        season,
        episode,
        fetchImpl,
        isAuthorizedStream: () => torrentio.isAuthorizedStream?.() || false
      }).catch((err) => {
        console.warn(`[StremioStreamAddon] Error fetching from ${addon.name}:`, err.message);
        return [];
      }));
    });
  }

  if (animeTitle && animeEpisode && anicli.apiBaseUrl) {
    tasks.push(getAnimeEpisodeSources({
      title: animeTitle,
      episode: animeEpisode,
      fetchImpl,
      ...anicli
    }));
  }

  const settled = await Promise.allSettled(tasks);
  const sources = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  const errors = settled
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason?.message || String(result.reason));

  return {
    query: { id, title, type, season, episode, animeTitle, animeEpisode, annatar: Boolean(annatar.baseUrl) },
    count: sources.length,
    playableCount: sources.filter((source) => source.authorized && (source.url || source.infoHash)).length,
    options: sources.sort(sortPlaybackOptions).map(toPlayableOption),
    errors
  };
}
