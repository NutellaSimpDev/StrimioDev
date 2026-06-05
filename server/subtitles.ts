import { resolve } from 'node:path';
import type { SubtitleResult } from './types.js';

export const subsDir = resolve(process.cwd(), 'subs');

type SubtitleLookup = {
  imdbId: string;
  lang: string;
  filename?: string;
  type?: string;
  season?: number;
  episode?: number;
};

const addonBaseUrl = 'https://opensubtitlesv3-pro.dexter21767.com/eyJsYW5ncyI6WyJzcGFuaXNoIiwic3BhbmlzaC1sYSIsImVuZ2xpc2giXSwic291cmNlIjoiYWxsIiwiYWlUcmFuc2xhdGVkIjp0cnVlLCJhdXRvQWRqdXN0bWVudCI6ZmFsc2V9';

function normalizeLang(lang: string) {
  const l = lang.toLowerCase();
  if (l === 'lat' || l === 'la') return 'Español Latino';
  if (l === 'spa' || l === 'es') return 'Español';
  if (l === 'eng' || l === 'en') return 'English';
  return lang.toUpperCase();
}

function stremioLangMatches(candidate: string | undefined, requested: string) {
  if (!candidate) return false;
  const c = candidate.toLowerCase();
  const r = requested.toLowerCase();
  
  if (c === r) return true;
  
  if (r === 'lat' || r === 'la') {
    return c.includes('lat') || c.includes('la') || c === 'spa' || c === 'es' || c.includes('spanish');
  }
  if (r === 'spa' || r === 'es') {
    return c === 'spa' || c === 'es' || c.includes('spanish');
  }
  if (r === 'eng' || r === 'en') {
    return c === 'eng' || c === 'en' || c.includes('english');
  }
  return false;
}

const addonCache = new Map<string, any>();

async function fetchAddonSubtitles(imdbId: string, type: string, season?: number, episode?: number) {
  const videoId = type === 'series' && season && episode ? `${imdbId}:${season}:${episode}` : imdbId;
  const contentType = type === 'series' ? 'series' : 'movie';
  const cacheKey = `${contentType}_${videoId}`;
  
  if (addonCache.has(cacheKey)) {
    return addonCache.get(cacheKey);
  }
  
  const configuredAddons = process.env.STREMIO_SUBTITLE_ADDONS
    ? process.env.STREMIO_SUBTITLE_ADDONS.split(',').map(addon => addon.trim().replace('/manifest.json', ''))
    : [];

  const addons = [
    ...configuredAddons,
    'https://opensubtitlesv3-pro.dexter21767.com/eyJsYW5ncyI6WyJzcGFuaXNoIiwic3BhbmlzaC1sYSIsImVuZ2xpc2giXSwic291cmNlIjoiYWxsIiwiYWlUcmFuc2xhdGVkIjp0cnVlLCJhdXRvQWRqdXN0bWVudCI6ZmFsc2V9',
    'https://opensubtitles-v3.strem.io'
  ].filter(Boolean) as string[];

  let subtitles: any[] = [];
  let success = false;
  let lastError: any = null;

  for (const baseUrl of addons) {
    try {
      const url = `${baseUrl}/subtitles/${contentType}/${encodeURIComponent(videoId)}.json`;
      const response = await fetch(url, { 
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4000) 
      });
      if (!response.ok) {
        throw new Error(`Addon respondio ${response.status}`);
      }
      
      const data = await response.json() as { subtitles?: any[] };
      subtitles = data.subtitles || [];
      success = true;
      break;
    } catch (error) {
      lastError = error;
      console.warn(`[OpenSubtitlesV3] Fallo descarga desde ${baseUrl}:`, error instanceof Error ? error.message : String(error));
    }
  }

  if (!success) {
    throw lastError || new Error('No se pudo conectar a ningun addon de subtitulos');
  }
  
  addonCache.set(cacheKey, subtitles);
  // Clear cache after 30 seconds
  setTimeout(() => addonCache.delete(cacheKey), 30000);
  
  return subtitles;
}

export async function findSubtitle({
  imdbId,
  lang,
  type = 'movie',
  season,
  episode
}: SubtitleLookup): Promise<SubtitleResult | null> {
  try {
    const subtitles = await fetchAddonSubtitles(imdbId, type, season, episode);
    
    // Find a subtitle matching the requested language
    const match = subtitles.find((s: any) => s.url && stremioLangMatches(s.lang || s.id, lang));
    
    if (match) {
      return {
        id: match.id || String(Math.random()),
        lang,
        label: match.lang || normalizeLang(lang),
        provider: 'OpenSubtitlesV3',
        url: match.url
      };
    }
  } catch (error) {
    console.error('[OpenSubtitlesV3] Error fetching subtitles:', error);
  }
  return null;
}

export function hasSubtitleProvidersConfigured() {
  return true;
}
