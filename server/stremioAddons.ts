type StremioCatalog = {
  id: string;
  type: 'movie' | 'series';
  name?: string;
  extra?: Array<{ name: string; isRequired?: boolean }>;
  extraSupported?: string[];
  extraRequired?: string[];
};

type StremioManifest = {
  id?: string;
  name?: string;
  resources?: Array<string | { name?: string }>;
  catalogs?: StremioCatalog[];
};

type StremioMeta = {
  id?: string;
  imdb_id?: string;
  type?: string;
  name?: string;
  title?: string;
  poster?: string;
  background?: string;
  logo?: string;
  description?: string;
  overview?: string;
  imdbRating?: string;
  releaseInfo?: string;
  released?: string;
};

type NormalizedCatalogItem = {
  tmdbId: number;
  imdbId: string;
  title: string;
  mediaType: 'movie' | 'series';
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string;
  vote_average: number;
  release_date: string | null;
  source: string;
};

const manifestCache = new Map<string, Promise<StremioManifest>>();

export function normalizeStremioAddonUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const asHttps = trimmed.replace(/^stremio:\/\//i, 'https://');
  return asHttps
    .replace(/\/manifest\.json(?:\?.*)?$/i, '')
    .replace(/\/+$/, '');
}

export function parseAddonList(value = '') {
  return value
    .split(',')
    .map(normalizeStremioAddonUrl)
    .filter(Boolean);
}

function hasResource(manifest: StremioManifest, resourceName: string) {
  return (manifest.resources || []).some((resource) => {
    return typeof resource === 'string' ? resource === resourceName : resource.name === resourceName;
  });
}

export async function fetchStremioManifest(baseUrl: string, fetchImpl = fetch) {
  const base = normalizeStremioAddonUrl(baseUrl);
  if (!manifestCache.has(base)) {
    manifestCache.set(base, fetchImpl(`${base}/manifest.json`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(7000)
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Manifest ${base} respondio ${response.status}.`);
      return response.json() as Promise<StremioManifest>;
    }));
  }

  return manifestCache.get(base)!;
}

function catalogSupportsSearch(catalog: StremioCatalog) {
  const extras = new Set([
    ...(catalog.extraSupported || []),
    ...(catalog.extra || []).map((extra) => extra.name)
  ]);
  return extras.has('search');
}

function catalogHasBlockingRequiredExtra(catalog: StremioCatalog) {
  const required = new Set([
    ...(catalog.extraRequired || []),
    ...(catalog.extra || []).filter((extra) => extra.isRequired).map((extra) => extra.name)
  ]);
  required.delete('search');
  required.delete('skip');
  return required.size > 0;
}

function catalogUrl(baseUrl: string, catalog: StremioCatalog, search?: string) {
  const base = normalizeStremioAddonUrl(baseUrl);
  if (search && catalogSupportsSearch(catalog)) {
    return `${base}/catalog/${catalog.type}/${catalog.id}/search=${encodeURIComponent(search)}.json`;
  }
  return `${base}/catalog/${catalog.type}/${catalog.id}.json`;
}

function normalizeMeta(meta: StremioMeta, mediaType: 'movie' | 'series', addonName: string): NormalizedCatalogItem | null {
  const imdbId = meta.imdb_id || (meta.id?.startsWith('tt') ? meta.id : null);
  if (!imdbId) return null;

  return {
    tmdbId: 0,
    imdbId,
    title: meta.name || meta.title || imdbId,
    mediaType,
    poster_path: meta.poster || meta.logo || null,
    backdrop_path: meta.background || meta.poster || null,
    overview: meta.description || meta.overview || `Catalogo Stremio: ${addonName}`,
    vote_average: Number(meta.imdbRating || 0),
    release_date: meta.released || meta.releaseInfo || null,
    source: `stremio:${addonName}`
  };
}

export async function fetchStremioCatalogItems({
  addons,
  type,
  search,
  limit = 20,
  fetchImpl = fetch
}: {
  addons: string[];
  type: 'movie' | 'series';
  search?: string;
  limit?: number;
  fetchImpl?: typeof fetch;
}) {
  const results = await Promise.allSettled(addons.map(async (baseUrl) => {
    const manifest = await fetchStremioManifest(baseUrl, fetchImpl);
    if (!hasResource(manifest, 'catalog')) return [];

    const catalogs = (manifest.catalogs || [])
      .filter((catalog) => catalog.type === type)
      .filter((catalog) => search ? catalogSupportsSearch(catalog) : !catalogHasBlockingRequiredExtra(catalog))
      .slice(0, search ? 16 : 10);

    const catalogResults = await Promise.allSettled(catalogs.map(async (catalog) => {
      const response = await fetchImpl(catalogUrl(baseUrl, catalog, search), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error(`${manifest.name || baseUrl} catalogo ${catalog.id} respondio ${response.status}.`);
      const data = await response.json() as { metas?: StremioMeta[] };
      return (data.metas || [])
        .map((meta) => normalizeMeta(meta, type, manifest.name || manifest.id || new URL(normalizeStremioAddonUrl(baseUrl)).hostname))
        .filter((item): item is NormalizedCatalogItem => Boolean(item));
    }));

    return catalogResults.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  }));

  const deduped = new Map<string, NormalizedCatalogItem>();
  results
    .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    .forEach((item) => {
      if (item && !deduped.has(item.imdbId)) deduped.set(item.imdbId, item);
    });

  return Array.from(deduped.values()).filter(Boolean).slice(0, limit);
}
