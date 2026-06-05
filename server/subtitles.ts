import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AdmZip from 'adm-zip';
import type { SubtitleResult } from './types.js';
import { normalizeStremioAddonUrl, parseAddonList } from './stremioAddons.js';

export const subsDir = resolve(process.cwd(), 'subs');

type SubtitleLookup = {
  imdbId: string;
  lang: string;
  filename?: string;
  type?: string;
  season?: number;
  episode?: number;
};

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
    return c.includes('lat') || c.includes('la') || c === 'spa' || c === 'spl' || c === 'es' || c.includes('spanish');
  }
  if (r === 'spa' || r === 'es') {
    return c === 'spa' || c === 'spl' || c === 'es' || c.includes('spanish');
  }
  if (r === 'eng' || r === 'en') {
    return c === 'eng' || c === 'en' || c.includes('english');
  }
  return false;
}

const addonCache = new Map<string, any>();

function cacheId(parts: Array<string | undefined>) {
  return createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 16);
}

function encodeStremioId(id: string) {
  return id.split(':').map((part) => encodeURIComponent(part)).join(':');
}

function srtToVtt(input: string) {
  const normalized = input
    .replace(/^\uFEFF/, '')
    .replace(/\r+/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .split('\n')
    .filter((line, index, lines) => {
      const next = lines[index + 1] || '';
      return !(line.trim().match(/^\d+$/) && next.includes('-->'));
    })
    .join('\n')
    .trim();

  return `WEBVTT\n\n${normalized}\n`;
}

function subtitleBufferToText(buffer: Buffer, contentType = '') {
  if (contentType.includes('zip') || buffer.subarray(0, 2).toString() === 'PK') {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntries().find((candidate) => {
      return /\.(srt|vtt|ass|ssa)$/i.test(candidate.entryName) && !candidate.isDirectory;
    });
    if (!entry) throw new Error('El ZIP de subtitulos no contiene .srt/.vtt compatible.');
    return entry.getData().toString('utf8');
  }

  return buffer.toString('utf8');
}

function subtitleTextToVtt(text: string) {
  if (text.trimStart().startsWith('WEBVTT')) return text;

  if (text.includes('[Events]') && text.includes('Dialogue:')) {
    const lines = text.split('\n')
      .filter((line) => line.startsWith('Dialogue:'))
      .map((line) => line.split(',').slice(9).join(',').replace(/\\N/g, '\n'));
    return `WEBVTT\n\n00:00:00.000 --> 99:59:59.000\n${lines.join('\n')}\n`;
  }

  return srtToVtt(text);
}

async function materializeSubtitle(url: string, targetPath: string) {
  const response = await fetch(url, {
    headers: { Accept: '*/*' },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Descarga de subtitulos respondio ${response.status}.`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const text = subtitleBufferToText(buffer, response.headers.get('content-type') || '');
  const vtt = subtitleTextToVtt(text);
  await writeFile(targetPath, vtt, 'utf8');
}

async function fetchAddonSubtitles(imdbId: string, type: string, season?: number, episode?: number) {
  const videoId = type === 'series' && season && episode ? `${imdbId}:${season}:${episode}` : imdbId;
  const contentType = type === 'series' ? 'series' : 'movie';
  const cacheKey = `${contentType}_${videoId}`;
  
  if (addonCache.has(cacheKey)) {
    return addonCache.get(cacheKey);
  }
  
  const configuredAddons = parseAddonList(process.env.STREMIO_SUBTITLE_ADDONS || '');

  const addons = [...new Set([
    ...configuredAddons,
    'https://opensubtitlesv3-pro.dexter21767.com/eyJsYW5ncyI6WyJzcGFuaXNoIiwic3BhbmlzaC1sYSIsImVuZ2xpc2giXSwic291cmNlIjoiYWxsIiwiYWlUcmFuc2xhdGVkIjp0cnVlLCJhdXRvQWRqdXN0bWVudCI6ZmFsc2V9',
    'https://opensubtitles-v3.strem.io'
  ].map(normalizeStremioAddonUrl).filter(Boolean) as string[])];

  const subtitles: any[] = [];
  let success = false;
  let lastError: any = null;

  for (const baseUrl of addons) {
    try {
      const url = `${baseUrl}/subtitles/${contentType}/${encodeStremioId(videoId)}.json`;
      const response = await fetch(url, { 
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4000) 
      });
      if (!response.ok) {
        throw new Error(`Addon respondio ${response.status}`);
      }
      
      const data = await response.json() as { subtitles?: any[] };
      subtitles.push(...(data.subtitles || []));
      success = true;
    } catch (error) {
      lastError = error;
      console.warn(`[OpenSubtitlesV3] Fallo descarga desde ${baseUrl}:`, error instanceof Error ? error.message : String(error));
    }
  }

  if (!success) {
    throw lastError || new Error('No se pudo conectar a ningun addon de subtitulos');
  }
  
  const deduped = Array.from(new Map(subtitles.map((subtitle) => [subtitle.url || subtitle.id, subtitle])).values());
  addonCache.set(cacheKey, deduped);
  // Clear cache after 30 seconds
  setTimeout(() => addonCache.delete(cacheKey), 30000);
  
  return deduped;
}

export async function findSubtitle({
  imdbId,
  lang,
  type = 'movie',
  season,
  episode
}: SubtitleLookup): Promise<SubtitleResult | null> {
  const results = await findSubtitles({ imdbId, lang, type, season, episode }, 1);
  return results[0] || null;
}

export async function findSubtitles({
  imdbId,
  lang,
  type = 'movie',
  season,
  episode
}: SubtitleLookup, limit = 3): Promise<SubtitleResult[]> {
  await mkdir(subsDir, { recursive: true });

  try {
    const subtitles = await fetchAddonSubtitles(imdbId, type, season, episode);
    
    const matches = subtitles.filter((s: any) => s.url && stremioLangMatches(s.lang || s.id, lang));
    const results: SubtitleResult[] = [];

    for (const match of matches) {
      const id = cacheId([imdbId, type, season ? String(season) : undefined, episode ? String(episode) : undefined, lang, match.id || match.url]);
      const targetPath = join(subsDir, `${id}.vtt`);
      const publicUrl = `/subtitles/${id}.vtt`;

      try {
        await readFile(targetPath, 'utf8');
      } catch {
        try {
          await materializeSubtitle(match.url, targetPath);
        } catch (error) {
          console.warn('[OpenSubtitlesV3] Subtitulo descartado:', error instanceof Error ? error.message : String(error));
          continue;
        }
      }

      results.push({
        id,
        lang,
        label: match.lang || normalizeLang(lang),
        provider: 'OpenSubtitlesV3',
        url: publicUrl
      });

      if (results.length >= limit) return results;
    }

    return results;
  } catch (error) {
    console.error('[OpenSubtitlesV3] Error fetching subtitles:', error);
  }
  return [];
}

export function hasSubtitleProvidersConfigured() {
  return true;
}
