import { getAnimeEpisodeSources } from './clients/anicliClient.js';
import { getAnnatarStreams } from './clients/annatarClient.js';
import { getTorrentioStreams } from './clients/torrentioClient.js';

function sortPlaybackOptions(a, b) {
  if (Number(b.authorized) !== Number(a.authorized)) return Number(b.authorized) - Number(a.authorized);
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
  fetchImpl = fetch
}) {
  const tasks = [];

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
