import { Router } from 'express';
import * as cheerio from 'cheerio';
import { resolveUnifiedPlayback } from '../../src/unifiedContentResolver.js';
import { authorizePlayback } from '../sessionStore.js';
import type { PlaybackOption } from '../types.js';

const router = Router();
const requestTimeoutMs = 15000;
const nativeAnimeBaseUrl = process.env.ANIME_NATIVE_BASE_URL || 'https://anitaku.pe';
const ajaxEpisodeBaseUrl = process.env.ANIME_NATIVE_AJAX_BASE_URL || 'https://ajax.gogocdn.net';

type AnimeSource = {
  provider: 'anime';
  providerId: string;
  sourceKind: 'hls' | 'http';
  title: string;
  quality: string;
  server: string;
  url: string;
  headers: Record<string, string>;
  subtitles: unknown[];
  authorized: boolean;
  blockedReason: string;
};

type TmdbTvResult = {
  id: number;
  name?: string;
  original_name?: string;
  original_language?: string;
  origin_country?: string[];
  first_air_date?: string;
  popularity?: number;
};

type AnimeResolveOption = AnimeSource | PlaybackOption;

type ScrapeContext = {
  baseUrl: string;
  title: string;
  episode: number;
};

interface AnimeExtractor {
  name: string;
  extract: (html: string, pageUrl: string) => Promise<string | null>;
}

function getDefaultHeaders(referer?: string) {
  return {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
    ...(referer ? { Referer: referer } : {})
  };
}

function getAjaxHeaders(referer?: string) {
  return {
    ...getDefaultHeaders(referer),
    'X-Requested-With': 'XMLHttpRequest'
  };
}

async function fetchText(url: string, referer?: string) {
  const response = await fetch(url, {
    headers: getDefaultHeaders(referer),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Fetch HTML respondio ${response.status} para ${url}.`);
  }

  return response.text();
}

async function fetchTextWithHeaders(url: string, headers: Record<string, string>) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Fetch respondio ${response.status} para ${url}.`);
  }

  return response.text();
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(requestTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Fetch JSON respondio ${response.status} para ${url}.`);
  }

  return response.json() as Promise<T>;
}

async function fetchTmdbJson<T>(url: string) {
  const token = process.env.TMDB_BEARER_TOKEN;
  const apiKey = process.env.TMDB_API_KEY;
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const requestUrl = new URL(url);
  if (!token && apiKey && !requestUrl.searchParams.has('api_key')) {
    requestUrl.searchParams.set('api_key', apiKey);
  }

  const response = await fetch(requestUrl, {
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(`TMDB respondio ${response.status} al mapear anime.`);
  }

  return response.json() as Promise<T>;
}

function absoluteUrl(url: string, baseUrl: string) {
  return new URL(url, baseUrl).toString();
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeTitle(value: string) {
  return slugify(value)
    .replace(/\b(?:season|temporada|part|parte|cour|tv|movie|pelicula)\b/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function scoreTmdbAnimeCandidate(candidate: TmdbTvResult, requestedTitle: string) {
  const requested = normalizeTitle(requestedTitle);
  const name = normalizeTitle(candidate.name || '');
  const originalName = normalizeTitle(candidate.original_name || '');
  const country = candidate.origin_country || [];
  let score = 0;

  if (candidate.original_language === 'ja') score += 70;
  if (country.includes('JP')) score += 60;
  if (name === requested || originalName === requested) score += 80;
  if (name.includes(requested) || requested.includes(name)) score += 25;
  if (originalName.includes(requested) || requested.includes(originalName)) score += 20;
  if (candidate.original_language === 'en' && !country.includes('JP')) score -= 30;
  score += Math.min(Number(candidate.popularity || 0), 100) / 20;

  return score;
}

async function findAnimeImdbIdFromTmdb(title: string) {
  if (!process.env.TMDB_BEARER_TOKEN && !process.env.TMDB_API_KEY) {
    throw new Error('TMDB no esta configurado; no puedo mapear anime a IMDb.');
  }

  const searchUrl = new URL('https://api.themoviedb.org/3/search/tv');
  searchUrl.searchParams.set('query', title);
  searchUrl.searchParams.set('language', 'es-ES');
  searchUrl.searchParams.set('include_adult', 'false');

  const searchData = await fetchTmdbJson<{ results?: TmdbTvResult[] }>(searchUrl.toString());
  const candidates = (searchData.results || [])
    .filter((candidate) => candidate.id)
    .map((candidate) => ({ ...candidate, score: scoreTmdbAnimeCandidate(candidate, title) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  for (const candidate of candidates) {
    const idsUrl = `https://api.themoviedb.org/3/tv/${candidate.id}/external_ids`;
    const ids = await fetchTmdbJson<{ imdb_id?: string | null }>(idsUrl);
    if (ids.imdb_id && /^tt\d+$/i.test(ids.imdb_id)) {
      return {
        imdbId: ids.imdb_id,
        tmdbId: candidate.id,
        title: candidate.name || candidate.original_name || title,
        originalTitle: candidate.original_name || candidate.name || title,
        score: candidate.score
      };
    }
  }

  throw new Error(`TMDB no encontro IMDb para el anime "${title}".`);
}

function extractM3u8Urls(html: string) {
  const normalized = decodeHtml(html).replace(/\\\//g, '/');
  const urls = new Set<string>();
  const m3u8Pattern = /https?:\/\/[^"'\s\\]+\.m3u8(?:\?[^"'\s\\]*)?/gi;
  let match: RegExpExecArray | null;

  while ((match = m3u8Pattern.exec(normalized))) {
    urls.add(match[0]);
  }

  return [...urls];
}

function normalizeSource(url: string, index: number, server = 'Anime HLS'): AnimeSource {
  return {
    provider: 'anime',
    providerId: 'native_anime_scraper',
    sourceKind: url.includes('.m3u8') ? 'hls' : 'http',
    title: `${server} ${index + 1}`,
    quality: index === 0 ? 'AUTO' : `ALT ${index + 1}`,
    server,
    url,
    headers: {},
    subtitles: [],
    authorized: true,
    blockedReason: ''
  };
}

function isPlayableAnimeOption(option: unknown) {
  if (!option || typeof option !== 'object') return false;
  const candidate = option as { url?: unknown; infoHash?: unknown };
  return Boolean(candidate.url || candidate.infoHash);
}

function extractEpisodeHints(title: string) {
  const hints = new Set<number>();
  const patterns = [
    /\bS\d{1,2}E(\d{1,4})\b/gi,
    /\bEP(?:ISODE)?\.?\s*0*(\d{1,4})\b/gi,
    /\bCAP(?:ITULO|ITULO)?\.?\s*0*(\d{1,4})\b/gi,
    /\bEpisodio\s*0*(\d{1,4})\b/gi,
    /\b-\s*0*(\d{1,4})\s*-/gi,
    /\b-\s*0*(\d{1,4})\s*\[/gi
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(title))) {
      const value = Number(match[1]);
      if (Number.isInteger(value) && value > 0) hints.add(value);
    }
  }

  return [...hints];
}

function parseAnimeTitleSeason(title: string): { cleanTitle: string; season: number } {
  let cleanTitle = title.trim();
  let season = 1;

  const seasonPattern = /\b(?:season\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*season)\b/i;
  const match = cleanTitle.match(seasonPattern);
  if (match) {
    season = Number(match[1] || match[2]);
    cleanTitle = cleanTitle.replace(seasonPattern, '').replace(/\s+-\s*$/, '').trim();
  }

  cleanTitle = cleanTitle.replace(/\s+/g, ' ').trim();
  return { cleanTitle, season };
}

function extractSeasonHints(title: string): number[] {
  const hints = new Set<number>();
  const patterns = [
    /\bS(\d{1,2})\b/gi,
    /\bS(\d{1,2})E\d{1,4}\b/gi,
    /\bSEASON\s*0*(\d{1,2})\b/gi,
    /\b(\d{1,2})(?:st|nd|rd|th)\s*SEASON\b/gi
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(title))) {
      const value = Number(match[1]);
      if (Number.isInteger(value) && value > 0) hints.add(value);
    }
  }
  return [...hints];
}

function scoreAnimePlaybackOption(option: PlaybackOption, episode: number, season = 1) {
  const text = `${option.title || ''} ${option.server || ''} ${option.provider || ''}`;
  const lower = text.toLowerCase();
  const hints = extractEpisodeHints(text);
  let score = 0;

  if (option.url && !option.infoHash) score += 15;
  if (/\b(nyaasi|nekobt|horriblesubs|tokyotosho|anidex|erai-raws|toons?hub|judas|anime time)\b/i.test(text)) score += 45;

  // Language scoring: Latino > Spain Spanish > English > Other
  let langScore = 10;
  if (
    /\b(latino|lat|la|lats)\b/i.test(lower) ||
    /latin\s*american/i.test(lower) ||
    /dual\s*lat/i.test(lower) ||
    /audio\s*lat/i.test(lower) ||
    /🇲🇽|🇨🇱|🇨🇴|🇵🇪|🇦🇷|🇻🇪|🇧🇴|🇺🇾|🇵🇾|🇨🇷|🇵🇦|🇬🇹|🇸🇻|🇭🇳|🇳🇮|🇨🇺|🇩🇴|🇪🇨/.test(lower)
  ) {
    langScore = 35;
  } else if (
    /\b(español|espanol|castellano|spa|esp|cast|es)\b/i.test(lower) ||
    /spanish/i.test(lower) ||
    /dual\s*esp/i.test(lower) ||
    /audio\s*esp/i.test(lower) ||
    /🇪🇸/.test(lower)
  ) {
    langScore = 25;
  } else if (
    /\b(french|fr|fra|italian|ita|portuguese|por|pt|german|ger|de|russian|rus|ru|multi)\b/i.test(lower) ||
    /🇫🇷|🇮🇹|🇵🇹|🇧🇷|🇩🇪|🇷🇺/.test(lower)
  ) {
    langScore = 0;
  }
  score += langScore;

  if (hints.includes(episode)) score += 120;
  if (hints.length && !hints.includes(episode)) score -= 80;
  if (lower.includes('batch') && hints.includes(episode)) score += 20;
  if (lower.includes('2023') && !lower.includes('anime')) score -= 35;

  // Season scoring and mismatch prevention
  const seasonHints = extractSeasonHints(text);
  if (seasonHints.length > 0) {
    if (!seasonHints.includes(season)) {
      score -= 150;
    } else {
      score += 50;
    }
  }

  const qualityRank = {
    '4K': 60,
    '2160P': 60,
    '1440P': 55,
    '2K': 55,
    '1080P': 50,
    '720P': 40,
    '576P': 35,
    '480P': 30,
    '360P': 20
  }[String(option.quality || '').toUpperCase()] || 0;

  return score + qualityRank;
}

const classicExtractor: AnimeExtractor = {
  name: 'Classic Selector',
  async extract(html: string, pageUrl: string): Promise<string | null> {
    const $ = cheerio.load(html);
    
    // Try data-video attribute (Gogoanime specific)
    const dataVideo = $('[data-video]').attr('data-video');
    if (dataVideo) {
      return absoluteUrl(dataVideo, pageUrl);
    }
    
    // Try common video iframe sources
    let embedUrl: string | null = null;
    $('iframe').each((_: any, el: any) => {
      const src = $(el).attr('src');
      if (src) {
        embedUrl = absoluteUrl(src, pageUrl);
        return false; // break
      }
    });
    
    return embedUrl;
  }
};

const wordPressExtractor: AnimeExtractor = {
  name: 'WordPress DooPlayer',
  async extract(html: string, pageUrl: string): Promise<string | null> {
    const $ = cheerio.load(html);
    let playerOption = $('.dooplay_player_option').first();
    if (!playerOption.length) {
      playerOption = $('[data-post][data-nume]').first();
    }
    
    const postId = playerOption.attr('data-post');
    const nume = playerOption.attr('data-nume') || '1';
    const type = playerOption.attr('data-type') || 'tv'; // or 'movie'
    
    if (!postId) {
      // Try searching script tags for doo_player variables if not in classes
      let foundPostId: string | null = null;
      let foundType = 'tv';
      $('script').each((_: any, el: any) => {
        const text = $(el).text();
        const postMatch = text.match(/post_id\s*[:=]\s*["']?(\d+)["']?/i);
        if (postMatch) {
          foundPostId = postMatch[1];
          const typeMatch = text.match(/context\s*[:=]\s*["']?([^"']+)["']?/i);
          if (typeMatch) foundType = typeMatch[1];
        }
      });
      if (!foundPostId) return null;
      return fetchWordPressEmbed(pageUrl, foundPostId, nume, foundType);
    }
    
    return fetchWordPressEmbed(pageUrl, postId, nume, type);
  }
};

async function fetchWordPressEmbed(pageUrl: string, postId: string, nume: string, type: string): Promise<string | null> {
  const parsedUrl = new URL(pageUrl);
  const ajaxUrl = `${parsedUrl.origin}/wp-admin/admin-ajax.php`;
  
  const params = new URLSearchParams();
  params.append('action', 'doo_player');
  params.append('post', postId);
  params.append('nume', nume);
  params.append('type', type);
  
  const response = await fetch(ajaxUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': pageUrl,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: params.toString(),
    signal: AbortSignal.timeout(10000)
  });
  
  if (!response.ok) return null;
  
  let data: { embed_url?: string; iframe?: string };
  try {
    data = await response.json() as { embed_url?: string; iframe?: string };
  } catch (error) {
    return null;
  }

  if (data.embed_url) {
    return absoluteUrl(data.embed_url, pageUrl);
  }
  
  if (data.iframe) {
    const iframeSrcMatch = data.iframe.match(/src=["']([^"']+)["']/i);
    if (iframeSrcMatch?.[1]) {
      return absoluteUrl(iframeSrcMatch[1], pageUrl);
    }
  }
  
  return null;
}

export class NativeAnimeProvider {
  baseUrl: string;

  constructor(baseUrl = nativeAnimeBaseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async search(query: string) {
    const searchUrl = `${this.baseUrl}/filter.html?keyword=${encodeURIComponent(query)}`;
    const html = await fetchTextWithHeaders(searchUrl, getAjaxHeaders(this.baseUrl));
    const $ = cheerio.load(html);
    const results: Array<{ id: string; title: string }> = [];

    $('.name a').each((_: any, el: any) => {
      const href = $(el).attr('href') || '';
      const title = $(el).attr('title') || $(el).text() || '';
      const id = href.split('/category/').pop() || '';
      if (id && title) {
        results.push({ id: decodeHtml(id), title: decodeHtml(title) });
      }
    });

    if (results.length) return results;

    $('a').each((_: any, el: any) => {
      const href = $(el).attr('href') || '';
      if (href.includes('/category/')) {
        const id = href.split('/').filter(Boolean).pop() || '';
        const title = $(el).text().trim();
        if (id && title) {
          results.push({ id, title });
        }
      }
    });

    return results;
  }

  async getEpisodeList(animeId: string) {
    const overviewUrl = `${this.baseUrl}/category/${animeId}`;
    const html = await fetchTextWithHeaders(overviewUrl, getDefaultHeaders(this.baseUrl));
    const $ = cheerio.load(html);

    const movieId = ($('#movie_id').val() || $('[name="movie_id"]').val() || '') as string;
    if (!movieId) {
      const episodes: Array<{ episodeId: string; episodeNumber: number }> = [];
      const episodePattern = /episode[-\s]+(\d+)/i;
      const animeSlug = animeId.replace(/-\d+$/, '');

      $('a').each((_: any, el: any) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text();
        const haystack = `${href} ${text}`;
        if (!slugify(haystack).includes(animeSlug)) return;
        const match = haystack.match(episodePattern);
        if (!match) return; // continue -> return
        episodes.push({
          episodeId: absoluteUrl(href, this.baseUrl),
          episodeNumber: Number.parseInt(match[1], 10)
        });
      });

      return [...new Map(episodes
        .filter((episode) => Number.isFinite(episode.episodeNumber))
        .map((episode) => [episode.episodeNumber, episode])).values()]
        .sort((a, b) => a.episodeNumber - b.episodeNumber);
    }

    const epListUrl = `${ajaxEpisodeBaseUrl}/ajax/load-list-episode?ep_start=0&ep_end=2000&id=${movieId}&default_ep=0&alias=${encodeURIComponent(animeId)}`;
    const epHtml = await fetchTextWithHeaders(epListUrl, getAjaxHeaders(overviewUrl));
    const $ep = cheerio.load(epHtml);
    const episodes: Array<{ episodeId: string; episodeNumber: number }> = [];

    $ep('a').each((_: any, el: any) => {
      const href = $ep(el).attr('href') || '';
      const text = $ep(el).text().trim();
      const match = href.match(/-episode-(\d+)/i) || text.match(/(\d+)/);
      if (match) {
        episodes.push({
          episodeId: href.replace(/^\//, ''),
          episodeNumber: Number.parseInt(match[1], 10)
        });
      }
    });

    return episodes
      .filter((episode) => Number.isFinite(episode.episodeNumber))
      .sort((a, b) => a.episodeNumber - b.episodeNumber);
  }

  async getStreamUrl(episodeId: string) {
    const episodeUrl = episodeId.startsWith('http')
      ? episodeId
      : `${this.baseUrl}/${episodeId.replace(/^\//, '')}`;
      
    const html = await fetchTextWithHeaders(episodeUrl, getDefaultHeaders(this.baseUrl));
    
    // Pattern of multiple extractors
    const extractors = [classicExtractor, wordPressExtractor];
    let embedUrl: string | null = null;
    
    for (const extractor of extractors) {
      try {
        embedUrl = await extractor.extract(html, episodeUrl);
        if (embedUrl) {
          console.log(`[AnimeScraper] Extracted embed URL using ${extractor.name}: ${embedUrl}`);
          break;
        }
      } catch (err) {
        console.error(`[AnimeScraper] Extractor ${extractor.name} failed:`, err);
      }
    }
    
    if (!embedUrl) {
      throw new Error('No se encontro reproductor embebido para el episodio usando ningun extractor.');
    }
    
    const embedHtml = await fetchTextWithHeaders(embedUrl, getDefaultHeaders(episodeUrl));
    const hlsUrls = extractM3u8Urls(embedHtml);
    if (hlsUrls.length) return normalizeSource(hlsUrls[0], 0, new URL(embedUrl).host);
    
    const mp4Match = decodeHtml(embedHtml).match(/https?:\/\/[^"'\s\\]+\.(?:mp4|webm)(?:\?[^"'\s\\]*)?/i);
    if (mp4Match?.[0]) return normalizeSource(mp4Match[0], 0, new URL(embedUrl).host);
    
    throw new Error('No se encontro enlace HLS/MP4 dentro del player embebido.');
  }
}

const nativeAnimeProvider = new NativeAnimeProvider();

async function resolveWithAnitakuNative(title: string, episode: number) {
  const results = await nativeAnimeProvider.search(title);
  if (!results.length) throw new Error('Anitaku no devolvio resultados de busqueda.');

  const target = slugify(title);
  const best = results
    .map((result) => {
      const resultSlug = slugify(result.title);
      const exactBoost = Number(resultSlug === target || result.id === target) * 100;
      const overlap = target.split('-').filter((part) => part.length > 2 && resultSlug.includes(part)).length;
      return { ...result, score: exactBoost + overlap };
    })
    .sort((a, b) => b.score - a.score)[0];

  const episodes = await nativeAnimeProvider.getEpisodeList(best.id);
  const selectedEpisode = episodes.find((candidate) => candidate.episodeNumber === episode);
  if (!selectedEpisode) throw new Error(`Anitaku no devolvio episodio ${episode} para ${best.title}.`);

  return [await nativeAnimeProvider.getStreamUrl(selectedEpisode.episodeId)];
}

async function resolveWithNativeHtmlScraper(title: string, episode: number) {
  const baseUrl = process.env.ANIME_SCRAPER_BASE_URL;
  if (!baseUrl) return [];

  const context = { baseUrl, title, episode };
  const searchPath = process.env.ANIME_SCRAPER_SEARCH_PATH || '/search.html?keyword={query}';
  const searchUrl = absoluteUrl(searchPath.replaceAll('{query}', encodeURIComponent(title)), baseUrl);
  const searchHtml = await fetchText(searchUrl, baseUrl);
  
  const $ = cheerio.load(searchHtml);
  const target = slugify(title);
  let bestLink: string | null = null;
  let bestScore = -1;
  
  $('a').each((_: any, el: any) => {
    const href = $(el).attr('href');
    const text = $(el).text();
    if (href) {
      const haystack = `${text} ${href}`.toLowerCase();
      if (target.split('-').every((part) => part.length < 3 || haystack.includes(part))) {
        const textSlug = slugify(text);
        const hrefSlug = slugify(new URL(absoluteUrl(href, baseUrl)).pathname);
        const exactBoost = Number(textSlug === target || hrefSlug.includes(target)) * 100;
        const overlap = target.split('-').filter((part) => textSlug.includes(part) || hrefSlug.includes(part)).length;
        const score = exactBoost + overlap;
        if (score > bestScore) {
          bestScore = score;
          bestLink = absoluteUrl(href, baseUrl);
        }
      }
    }
  });
  
  const animePageUrl = bestLink;
  if (!animePageUrl) throw new Error('No se encontro resultado de anime en el proveedor HTML configurado.');

  const animeHtml = await fetchText(animePageUrl, searchUrl);
  const $anime = cheerio.load(animeHtml);
  
  const explicitTemplate = process.env.ANIME_SCRAPER_EPISODE_PATH_TEMPLATE;
  let episodeUrl: string | null = null;
  
  if (explicitTemplate) {
    const animePath = new URL(animePageUrl).pathname.replace(/^\//, '').replace(/\/$/, '');
    const slug = animePath.split('/').pop() || slugify(title);
    episodeUrl = absoluteUrl(explicitTemplate
      .replaceAll('{slug}', slug)
      .replaceAll('{episode}', String(episode)), baseUrl);
  } else {
    const episodePattern = new RegExp(`(?:episode|episodio|ep)[^0-9]{0,8}${episode}(?:\\D|$)|(?:-|/)${episode}(?:\\D|$)`, 'i');
    let bestEpLink: string | null = null;
    let bestEpExact = -1;
    
    $anime('a').each((_: any, el: any) => {
      const href = $anime(el).attr('href');
      const text = $anime(el).text();
      if (href && episodePattern.test(`${text} ${href}`)) {
        const isExact = Number(new RegExp(`(?:episode|episodio|ep)[^0-9]{0,8}${episode}\\b`, 'i').test(`${text} ${href}`));
        if (isExact > bestEpExact) {
          bestEpExact = isExact;
          bestEpLink = absoluteUrl(href, baseUrl);
        }
      }
    });
    episodeUrl = bestEpLink;
  }
  
  if (!episodeUrl) throw new Error(`No se encontro episodio ${episode} en el proveedor HTML configurado.`);

  const episodeHtml = await fetchText(episodeUrl, animePageUrl);
  const directUrls = extractM3u8Urls(episodeHtml);
  if (directUrls.length) return directUrls.map((url, index) => normalizeSource(url, index, 'Anime Direct'));

  const $epPage = cheerio.load(episodeHtml);
  let iframeUrl: string | null = null;
  
  const iframeMatch = episodeHtml.match(/<iframe\b[^>]*src=["']([^"']+)["'][^>]*>/i);
  if (iframeMatch?.[1]) {
    iframeUrl = absoluteUrl(decodeHtml(iframeMatch[1]), episodeUrl);
  } else {
    const embedMatch = episodeHtml.match(/(?:embedUrl|file|source|src)\s*[:=]\s*["']([^"']+)["']/i);
    if (embedMatch?.[1]) {
      iframeUrl = absoluteUrl(decodeHtml(embedMatch[1]), episodeUrl);
    } else {
      $epPage('iframe').each((_: any, el: any) => {
        const src = $epPage(el).attr('src');
        if (src) {
          iframeUrl = absoluteUrl(src, episodeUrl!);
          return false;
        }
      });
    }
  }
  
  if (!iframeUrl) throw new Error('No se encontro iframe o source de video en la pagina del episodio.');

  const iframeHtml = await fetchText(iframeUrl, episodeUrl);
  const hlsUrls = extractM3u8Urls(iframeHtml);
  if (!hlsUrls.length) throw new Error('No se encontro enlace .m3u8 dentro del reproductor incrustado.');

  return hlsUrls.map((url, index) => normalizeSource(url, index, new URL(iframeUrl!).host));
}

async function resolveWithCompatibleApi(title: string, episode: number) {
  const baseUrl = process.env.ANIME_PROVIDER_BASE_URL;
  if (!baseUrl) return [];

  const searchUrl = `${baseUrl.replace(/\/$/, '')}/anime/gogoanime/${encodeURIComponent(title)}`;
  const searchData = await fetchJson<{ results?: Array<{ id?: string; title?: string }> }>(searchUrl);
  const animeId = searchData.results?.[0]?.id;
  if (!animeId) return [];

  const infoUrl = `${baseUrl.replace(/\/$/, '')}/anime/gogoanime/info/${encodeURIComponent(animeId)}`;
  const infoData = await fetchJson<{ episodes?: Array<{ id?: string; number?: number }> }>(infoUrl);
  const episodeId = infoData.episodes?.find((candidate) => Number(candidate.number) === episode)?.id;
  if (!episodeId) return [];

  const watchUrl = `${baseUrl.replace(/\/$/, '')}/anime/gogoanime/watch/${encodeURIComponent(episodeId)}`;
  const watchData = await fetchJson<{ sources?: Array<{ url?: string; quality?: string; server?: string; isM3U8?: boolean }> }>(watchUrl);

  return (watchData.sources || []).flatMap((source, index) => {
    if (!source.url) return [];
    return [{
      ...normalizeSource(source.url, index, source.server || 'Anime API'),
      providerId: 'anime_compatible_api',
      sourceKind: source.isM3U8 || source.url.includes('.m3u8') ? 'hls' : 'http',
      quality: source.quality || 'AUTO'
    }];
  });
}

async function resolveWithTorrentioAnimeFallback(title: string, episode: number, season = 1) {
  const mapped = await findAnimeImdbIdFromTmdb(title);
  const allowUnverified = process.env.STRIMIO_ALLOW_UNVERIFIED === 'true';
  const result = await resolveUnifiedPlayback({
    id: mapped.imdbId,
    title: mapped.title,
    type: 'series',
    season,
    episode,
    animeTitle: title,
    animeEpisode: episode,
    torrentio: {
      isAuthorizedStream: () => allowUnverified
    },
    annatar: {
      baseUrl: process.env.ANNATAR_BASE_URL,
      configPath: process.env.ANNATAR_CONFIG,
      isAuthorizedStream: () => allowUnverified
    },
    stremio: {
      streamAddons: process.env.STREMIO_STREAM_ADDONS
    }
  });

  const options = (result.options || [])
    .filter((option: PlaybackOption) => option.infoHash || option.url)
    .map((option: PlaybackOption) => ({
      ...option,
      authorized: true,
      blockedReason: ''
    }))
    .sort((a: PlaybackOption, b: PlaybackOption) => scoreAnimePlaybackOption(b, episode, season) - scoreAnimePlaybackOption(a, episode, season));

  options
    .filter((option: PlaybackOption) => option.infoHash)
    .forEach((option: PlaybackOption) => authorizePlayback(option, mapped.imdbId));

  return {
    options,
    errors: result.errors || [],
    mapped
  };
}

export async function resolveAnimeSources(title: string, episode: number, season = 1) {
  const errors: string[] = [];

  let cleanTitle = title;
  let resolvedSeason = season;
  if (season === 1) {
    const parsed = parseAnimeTitleSeason(title);
    cleanTitle = parsed.cleanTitle;
    resolvedSeason = parsed.season;
  }

  try {
    const torrentioResult = await resolveWithTorrentioAnimeFallback(cleanTitle, episode, resolvedSeason);
    if (torrentioResult.options.length) {
      return {
        options: torrentioResult.options,
        errors: torrentioResult.errors,
        provider: 'anime-torrentio',
        mapped: torrentioResult.mapped
      };
    }
    errors.push(...torrentioResult.errors);
    errors.push(`Torrentio/Stremio no devolvio fuentes para ${torrentioResult.mapped.imdbId}:${resolvedSeason}:${episode}.`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const resolvers = [resolveWithCompatibleApi, resolveWithAnitakuNative, resolveWithNativeHtmlScraper];

  for (const resolver of resolvers) {
    try {
      const options = await resolver(title, episode);
      if (options.length) return { options, errors, provider: 'native-anime' };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { options: [] as AnimeResolveOption[], errors, provider: 'anime-unavailable' };
}

router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) {
      res.status(400).json({ error: 'Parametro q requerido.' });
      return;
    }

    res.json(await nativeAnimeProvider.search(q));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/episodes/:id', async (req, res) => {
  try {
    res.json(await nativeAnimeProvider.getEpisodeList(req.params.id));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/resolve', async (req, res) => {
  try {
    const title = String(req.query.title || '').trim();
    const episode = Number(req.query.episode || 1);
    const season = Number(req.query.season || 1);
    const episodeId = String(req.query.episodeId || '').trim();

    if (episodeId) {
      const option = await nativeAnimeProvider.getStreamUrl(episodeId);
      res.json({
        count: 1,
        playableCount: 1,
        options: [option],
        errors: [],
        provider: 'anitaku-native'
      });
      return;
    }

    if (!title) {
      res.status(400).json({
        error: {
          code: 'ANIME_TITLE_REQUIRED',
          message: 'Parametro title o episodeId requerido.'
        }
      });
      return;
    }

    const { options, errors, provider, mapped } = await resolveAnimeSources(title, episode, season);
    res.json({
      count: options.length,
      playableCount: options.filter(isPlayableAnimeOption).length,
      options,
      errors,
      provider,
      mapped
    });
  } catch (error) {
    res.status(502).json({
      error: {
        code: 'ANIME_RESOLVE_FAILED',
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
});

export default router;
