import { useMemo, useState } from 'react';
import {
  BadgeDollarSign,
  Clapperboard,
  ExternalLink,
  Film,
  Globe2,
  Home,
  PackagePlus,
  PauseCircle,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  Tv,
  WalletCards
} from 'lucide-react';
import { canPlaySource, getRegistryStats, legalSources } from './sourceRegistry.js';

const tmdbToken = import.meta.env.VITE_TMDB_TOKEN;
const tmdbImageBase = 'https://image.tmdb.org/t/p/w500';
const region = import.meta.env.VITE_WATCH_REGION || 'US';
const addonStorageKey = 'strimio.catalog.addons.v1';
const defaultAddonUrls = [
  'https://v3-cinemeta.strem.io/manifest.json',
  'https://caching.stremio.net/manifest.json',
  'https://7a82163c306e-stremio-netflix-catalog-addon.baby-beamup.club/YmJjLHNoYSxpcWksY3JjLGFsNCxiYm8sYWN0LGl0djo6UEU6MTc3MTI5MTcxODM1MDowOjA6UEU%3D/manifest.json',
  'https://cinemeta.ratingposterdb.com/manifest.json'
];
const categories = {
  home: { label: 'Inicio', type: 'all' },
  movie: { label: 'Peliculas', type: 'movie' },
  series: { label: 'Series', type: 'series' },
  anime: { label: 'Anime', type: 'anime' },
  free: { label: 'Gratis legal', type: 'free' },
  playable: { label: 'Reproducibles', type: 'playable' }
};
const languageProfiles = {
  latam: {
    label: 'Español Latino',
    short: 'ES-LATAM',
    searchSuffix: 'audio latino',
    sourceHint: 'Audio latino'
  },
  enSubEs: {
    label: 'Inglés + subtítulos ES',
    short: 'EN + SUB ES',
    searchSuffix: 'english subtitles español',
    sourceHint: 'Inglés con subtítulos ES'
  },
  official: {
    label: 'Oficial sin filtro',
    short: 'Oficial',
    searchSuffix: '',
    sourceHint: 'Disponibilidad oficial'
  }
};

const featured = [
  {
    id: 'local-night',
    title: 'Night of the Living Dead',
    year: '1968',
    type: 'movie',
    overview: 'Clasico de dominio publico usado como ejemplo de fuente gratuita legal.',
    poster: 'https://archive.org/services/img/BBONightOfTheLivingDead1968HDV720601280x720p',
    archiveIdentifier: 'BBONightOfTheLivingDead1968HDV720601280x720p',
    category: 'movie',
    freeSources: [
      {
        name: 'Internet Archive',
        url: 'https://archive.org/details/BBONightOfTheLivingDead1968HDV720601280x720p',
        kind: 'Gratis legal',
        audio: 'Original',
        subtitles: 'Variable'
      }
    ],
    playableSources: [],
    paidSources: []
  },
  {
    id: 'local-matrix',
    title: 'The Matrix',
    year: '1999',
    type: 'movie',
    overview: 'Catalogo oficial via Cinemeta. Strimio buscara una fuente reproducible legal antes de activar el player.',
    poster: 'https://m.media-amazon.com/images/M/MV5BN2NmN2VhMTQtMDNiOS00NDlhLTliMjgtODE2ZTY0ODQyNDRhXkEyXkFqcGc@._V1_SX250.jpg',
    freeSources: [],
    playableSources: [],
    paidSources: officialSearchLinks('The Matrix'),
    sourceLabel: 'Cinemeta'
  },
  {
    id: 'local-reloaded',
    title: 'The Matrix Reloaded',
    year: '2003',
    type: 'movie',
    overview: 'Resultado de catalogo con poster real y rutas oficiales. El player interno se habilita solo con fuente verificable.',
    poster: 'https://m.media-amazon.com/images/M/MV5BNjAxYjkxNjktYTU0YS00NjFhLWIyMDEtMzEzMTJjMzRkMzQ1XkEyXkFqcGc@._V1_SX250.jpg',
    freeSources: [],
    playableSources: [],
    paidSources: officialSearchLinks('The Matrix Reloaded'),
    sourceLabel: 'Cinemeta'
  },
  {
    id: 'local-prelinger',
    title: 'Prelinger Archives',
    year: 'Archivo publico',
    type: 'collection',
    overview: 'Coleccion historica con material gratuito alojado en Internet Archive.',
    poster: 'https://archive.org/services/img/prelinger',
    category: 'free',
    freeSources: [
      {
        name: 'Internet Archive',
        url: 'https://archive.org/details/prelinger',
        kind: 'Archivo publico',
        audio: 'Original',
        subtitles: 'Variable'
      }
    ],
    playableSources: [],
    paidSources: []
  },
  {
    id: 'local-his-girl-friday',
    title: 'His Girl Friday',
    year: '1940',
    type: 'movie',
    overview: 'Clasico presente en archivos publicos. Strimio intentara resolver un MP4/WebM legal para el player interno.',
    poster: 'https://archive.org/services/img/turner_video_99341',
    archiveIdentifier: 'turner_video_99341',
    category: 'movie',
    freeSources: [
      {
        name: 'Internet Archive',
        url: 'https://archive.org/details/turner_video_99341',
        kind: 'Gratis legal',
        audio: 'Original/segun archivo',
        subtitles: 'Segun archivo'
      }
    ],
    playableSources: [],
    paidSources: [],
    sourceLabel: 'Gratis'
  },
  {
    id: 'local-anime',
    title: 'Anime legal ready',
    year: 'Categoria',
    type: 'anime',
    category: 'anime',
    overview: 'Espacio para providers de anime autorizados: canales oficiales, archivos CC, contenido propio o partners. El flujo tipo ani-cli se puede copiar sin usar scrapers no verificados.',
    poster: null,
    freeSources: [],
    playableSources: [],
    paidSources: officialSearchLinks('anime latino sub español'),
    sourceLabel: 'Anime'
  },
  {
    id: 'local-studio',
    title: 'Busca cualquier pelicula o serie',
    year: 'Ahora',
    type: 'search',
    overview: 'Strimio consulta fuentes gratis legales y, si no hay disponibilidad libre, te manda a tiendas o plataformas oficiales.',
    poster: null,
    freeSources: [],
    playableSources: [],
    paidSources: officialSearchLinks('movie')
  }
];

function officialSearchLinks(title, languagePreference = 'latam') {
  const profile = languageProfiles[languagePreference] || languageProfiles.latam;
  const fullQuery = [title, profile.searchSuffix].filter(Boolean).join(' ');
  const query = encodeURIComponent(fullQuery);
  return [
    { name: 'Apple TV', url: `https://tv.apple.com/search?term=${query}`, language: profile.sourceHint },
    { name: 'Prime Video', url: `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${query}`, language: profile.sourceHint },
    { name: 'Google TV', url: `https://play.google.com/store/search?q=${query}&c=movies`, language: profile.sourceHint },
    { name: 'YouTube', url: `https://www.youtube.com/results?search_query=${query}%20movie`, language: profile.sourceHint }
  ];
}

function addLanguageSignals(item, languagePreference) {
  const profile = languageProfiles[languagePreference] || languageProfiles.latam;
  const normalizedTitle = `${item.title} ${item.overview} ${item.sourceLabel || ''}`.toLowerCase();
  const hasSpanishSignal = /latino|latin|español|spanish|castellano/.test(normalizedTitle);
  const hasEnglishSignal = /english|ingl[eé]s|subtit/.test(normalizedTitle);
  const sourceBoost = item.freeSources.length ? 2 : 0;
  const languageBoost = languagePreference === 'latam'
    ? Number(hasSpanishSignal) * 3
    : Number(hasEnglishSignal || hasSpanishSignal) * 3;

  return {
    ...item,
    languagePreference,
    languageLabel: profile.short,
    languageMatch: hasSpanishSignal || hasEnglishSignal ? 'Coincidencia probable' : profile.sourceHint,
    languageRank: sourceBoost + languageBoost,
    freeSources: item.freeSources.map((source) => ({
      ...source,
      language: source.language || source.audio || profile.sourceHint
    })),
    paidSources: item.paidSources.length
      ? item.paidSources.map((source) => ({ ...source, language: source.language || profile.sourceHint }))
      : officialSearchLinks(item.title, languagePreference)
  };
}

function sortByLanguagePreference(items) {
  return [...items].sort((a, b) => {
    if (b.languageRank !== a.languageRank) return b.languageRank - a.languageRank;
    return b.freeSources.length - a.freeSources.length;
  });
}

function loadAddonUrls() {
  try {
    const saved = JSON.parse(localStorage.getItem(addonStorageKey));
    if (Array.isArray(saved) && saved.length) {
      const merged = [...saved];
      defaultAddonUrls.forEach((url) => {
        if (!merged.includes(url)) merged.push(url);
      });
      return merged;
    }
    return defaultAddonUrls;
  } catch {
    return defaultAddonUrls;
  }
}

function saveAddonUrls(urls) {
  localStorage.setItem(addonStorageKey, JSON.stringify(urls));
}

function getAddonBaseUrl(manifestUrl) {
  return manifestUrl.replace(/\/manifest\.json(?:\?.*)?$/i, '').replace(/\/$/, '');
}

function getAddonLabel(url) {
  if (url.includes('cinemeta')) return 'Cinemeta oficial';
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function isCatalogManifest(manifest) {
  const resources = manifest.resources || [];
  return resources.some((resource) => {
    return resource === 'catalog' || resource?.name === 'catalog';
  }) && Array.isArray(manifest.catalogs);
}

function normalizeStremioMeta(meta, addonName, manifestUrl) {
  const title = meta.name || meta.title || meta.id;
  return {
    id: `stremio-${addonName}-${meta.id}`,
    imdbId: meta.imdb_id || (String(meta.id).startsWith('tt') ? meta.id : null),
    title,
    year: meta.releaseInfo || meta.year || 'Stremio',
    type: meta.type === 'series' ? 'series' : 'movie',
    overview: meta.description || `Resultado del catalogo ${addonName}.`,
    poster: meta.poster || null,
    freeSources: [],
    paidSources: officialSearchLinks(title),
    sourceLabel: addonName,
    manifestUrl
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} respondio ${response.status}.`);
  return response.json();
}

async function loadAddon(manifestUrl) {
  const manifest = await fetchJson(manifestUrl);
  if (!isCatalogManifest(manifest)) {
    throw new Error('Ese manifest no expone catalogos compatibles.');
  }
  return manifest;
}

async function searchStremioAddon(manifestUrl, query) {
  const manifest = await loadAddon(manifestUrl);
  const baseUrl = getAddonBaseUrl(manifestUrl);
  const searchableCatalogs = manifest.catalogs
    .filter((catalog) => ['movie', 'series'].includes(catalog.type))
    .filter((catalog) => {
      const extras = catalog.extraSupported || catalog.extra?.map((extra) => extra.name) || [];
      return extras.includes('search');
    })
    .slice(0, 4);

  const catalogResults = await Promise.allSettled(searchableCatalogs.map(async (catalog) => {
    const encodedSearch = encodeURIComponent(query).replace(/%20/g, '%20');
    const url = `${baseUrl}/catalog/${catalog.type}/${catalog.id}/search=${encodedSearch}.json`;
    const data = await fetchJson(url);
    return (data.metas || []).slice(0, 8).map((meta) => normalizeStremioMeta(meta, manifest.name, manifestUrl));
  }));

  return catalogResults.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
}

async function searchStremioAddons(manifestUrls, query) {
  const settled = await Promise.allSettled(manifestUrls.map((url) => searchStremioAddon(url, query)));
  return settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
}

function normalizeArchiveItem(item) {
  const year = Array.isArray(item.year) ? item.year[0] : item.year;
  const description = Array.isArray(item.description) ? item.description[0] : item.description;
  const title = Array.isArray(item.title) ? item.title[0] : item.title;
  const identifier = item.identifier;

  return {
    id: `archive-${identifier}`,
    title: title || identifier,
    year: year || 'Archive',
    type: 'movie',
    overview: description ? String(description).replace(/<[^>]*>/g, '').slice(0, 240) : 'Resultado gratuito encontrado en Internet Archive.',
    poster: `https://archive.org/services/img/${identifier}`,
    archiveIdentifier: identifier,
    category: 'free',
    freeSources: [
      {
        name: 'Internet Archive',
        url: `https://archive.org/details/${identifier}`,
        kind: 'Ver gratis',
        audio: 'Original/segun archivo',
        subtitles: 'Segun archivo'
      },
      {
        name: 'Torrent IA',
        url: `https://archive.org/download/${identifier}/${identifier}_archive.torrent`,
        kind: 'Torrent',
        audio: 'Original/segun archivo',
        subtitles: 'Segun archivo'
      }
    ],
    playableSources: [],
    paidSources: officialSearchLinks(title || identifier),
    sourceLabel: 'Gratis'
  };
}

function normalizeTvmazeItem(result) {
  const show = result.show;
  return {
    id: `tvmaze-${show.id}`,
    title: show.name,
    year: show.premiered ? show.premiered.slice(0, 4) : 'Serie',
    type: 'series',
    category: 'series',
    overview: show.summary ? show.summary.replace(/<[^>]*>/g, '').slice(0, 260) : 'Serie encontrada en TVmaze.',
    poster: show.image?.medium || show.image?.original || null,
    freeSources: show.officialSite ? [{ name: 'Sitio oficial', url: show.officialSite, kind: 'Oficial', language: 'Segun plataforma' }] : [],
    playableSources: [],
    paidSources: officialSearchLinks(show.name),
    sourceLabel: 'Metadata'
  };
}

function normalizeJikanAnime(item) {
  const title = item.title_english || item.title;
  const year = item.year || item.aired?.from?.slice(0, 4) || 'Anime';
  const trailerUrl = item.trailer?.url || '';

  return {
    id: `jikan-${item.mal_id}`,
    malId: item.mal_id,
    title,
    year,
    type: 'anime',
    category: 'anime',
    overview: item.synopsis || 'Anime encontrado via Jikan/MyAnimeList. Metadata legal; reproduccion solo con fuente aprobada.',
    poster: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || null,
    freeSources: trailerUrl ? [{ name: 'Trailer oficial', url: trailerUrl, kind: 'YouTube / trailer', language: 'Segun fuente' }] : [],
    playableSources: [],
    paidSources: officialSearchLinks(title),
    sourceLabel: 'Jikan',
    providerId: 'jikan_mal'
  };
}

function normalizeTmdbItem(item, providers = null) {
  const title = item.title || item.name;
  const releaseDate = item.release_date || item.first_air_date || '';
  const flatrate = providers?.flatrate || [];
  const rent = providers?.rent || [];
  const buy = providers?.buy || [];
  const link = providers?.link;

  return {
    id: `tmdb-${item.media_type}-${item.id}`,
    tmdbId: item.id,
    title,
    year: releaseDate ? releaseDate.slice(0, 4) : 'TMDB',
    type: item.media_type === 'tv' ? 'series' : 'movie',
    category: item.media_type === 'tv' ? 'series' : 'movie',
    overview: item.overview || 'Titulo encontrado en TMDB.',
    poster: item.poster_path ? `${tmdbImageBase}${item.poster_path}` : null,
    freeSources: [],
    playableSources: [],
    paidSources: [
      ...flatrate.map((provider) => ({ name: provider.provider_name, url: link, kind: 'Streaming' })),
      ...rent.map((provider) => ({ name: provider.provider_name, url: link, kind: 'Alquilar' })),
      ...buy.map((provider) => ({ name: provider.provider_name, url: link, kind: 'Comprar' }))
    ].filter((provider) => provider.url),
    sourceLabel: providers ? 'Disponibilidad' : 'Catalogo'
  };
}

async function searchInternetArchive(query) {
  const params = new URLSearchParams({
    q: `mediatype:(movies) AND (${query}) AND (collection:(prelinger) OR collection:(opensource_movies) OR collection:(feature_films))`,
    'fl[]': ['identifier', 'title', 'description', 'year'],
    rows: '12',
    page: '1',
    output: 'json'
  });

  params.delete('fl[]');
  ['identifier', 'title', 'description', 'year'].forEach((field) => params.append('fl[]', field));

  const response = await fetch(`https://archive.org/advancedsearch.php?${params}`);
  if (!response.ok) throw new Error('Internet Archive no respondio.');
  const data = await response.json();
  return (data.response?.docs || []).map(normalizeArchiveItem);
}

async function searchTvmaze(query) {
  const response = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error('TVmaze no respondio.');
  const data = await response.json();
  return data.slice(0, 8).map(normalizeTvmazeItem);
}

async function searchJikanAnime(query) {
  const params = new URLSearchParams({
    q: query,
    limit: '12',
    sfw: 'true'
  });
  const response = await fetch(`https://api.jikan.moe/v4/anime?${params}`);
  if (!response.ok) throw new Error('Jikan no respondio.');
  const data = await response.json();
  return (data.data || []).map(normalizeJikanAnime);
}

async function fetchTmdbProviders(item) {
  if (!tmdbToken || !['movie', 'tv'].includes(item.media_type)) return null;
  const response = await fetch(`https://api.themoviedb.org/3/${item.media_type}/${item.id}/watch/providers`, {
    headers: { Authorization: `Bearer ${tmdbToken}` }
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.results?.[region] || null;
}

async function searchTmdb(query) {
  if (!tmdbToken) return [];
  const params = new URLSearchParams({
    query,
    include_adult: 'false',
    language: 'es-ES',
    page: '1'
  });
  const response = await fetch(`https://api.themoviedb.org/3/search/multi?${params}`, {
    headers: { Authorization: `Bearer ${tmdbToken}` }
  });
  if (!response.ok) throw new Error('TMDB no respondio.');
  const data = await response.json();
  const media = (data.results || []).filter((item) => ['movie', 'tv'].includes(item.media_type)).slice(0, 8);
  const withProviders = await Promise.all(media.map(async (item) => normalizeTmdbItem(item, await fetchTmdbProviders(item))));
  return withProviders;
}

function uniqueResults(results) {
  const seen = new Set();
  return results.filter((item) => {
    const key = `${item.title}-${item.year}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isBrowserPlayableFile(file) {
  const name = file.name?.toLowerCase() || '';
  const format = file.format?.toLowerCase() || '';
  return (
    name.endsWith('.mp4') ||
    name.endsWith('.webm') ||
    name.endsWith('.ogv') ||
    format.includes('mpeg4') ||
    format.includes('h.264') ||
    format.includes('webm') ||
    format.includes('ogg video')
  );
}

async function getArchivePlayableSources(identifier) {
  const metadata = await fetchJson(`https://archive.org/metadata/${identifier}`);
  return (metadata.files || [])
    .filter(isBrowserPlayableFile)
    .map((file) => ({
      name: file.name,
      label: file.format || file.name,
      url: `https://archive.org/download/${identifier}/${encodeURIComponent(file.name).replace(/%2F/g, '/')}`,
      providerId: 'internet_archive',
      licenseUrl: `https://archive.org/details/${identifier}`
    }));
}

async function findArchivePlayableByTitle(title) {
  const params = new URLSearchParams({
    q: `mediatype:(movies) AND title:("${title}") AND (collection:(prelinger) OR collection:(opensource_movies) OR collection:(feature_films))`,
    rows: '8',
    page: '1',
    output: 'json'
  });
  params.append('fl[]', 'identifier');
  params.append('fl[]', 'title');

  const data = await fetchJson(`https://archive.org/advancedsearch.php?${params}`);
  const docs = data.response?.docs || [];

  for (const doc of docs) {
    const sources = await getArchivePlayableSources(doc.identifier);
    if (sources.length) {
      return {
        identifier: doc.identifier,
        title: Array.isArray(doc.title) ? doc.title[0] : doc.title,
        sources
      };
    }
  }

  return null;
}

function App() {
  const [query, setQuery] = useState('matrix');
  const [results, setResults] = useState(featured);
  const [selected, setSelected] = useState(featured[0]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState('home');
  const [activeCategory, setActiveCategory] = useState('home');
  const [status, setStatus] = useState('Busca una pelicula o serie para encontrar opciones legales.');
  const [addonUrls, setAddonUrls] = useState(loadAddonUrls);
  const [addonInput, setAddonInput] = useState('');
  const [languagePreference, setLanguagePreference] = useState('latam');
  const [player, setPlayer] = useState({ state: 'idle', itemId: null, sources: [], currentUrl: '', message: 'Selecciona una fuente reproducible.' });

  const visibleResults = useMemo(() => {
    return results.filter((item) => {
      const matchesFilter = filter === 'all' || item.type === filter;
      if (!matchesFilter) return false;
      if (activeCategory === 'home') return true;
      if (activeCategory === 'free') return item.freeSources.length > 0;
      if (activeCategory === 'playable') return Boolean(item.archiveIdentifier || item.playableSources?.length);
      return item.type === activeCategory || item.category === activeCategory;
    });
  }, [activeCategory, filter, results]);

  async function runSearch(event) {
    event?.preventDefault();
    const term = query.trim();
    if (!term) return;

    setLoading(true);
    setStatus('Consultando fuentes legales...');

    try {
      const settled = await Promise.allSettled([
        searchStremioAddons(addonUrls, term),
        searchInternetArchive(term),
        searchTvmaze(term),
        searchJikanAnime(term),
        searchTmdb(term)
      ]);

      const nextResults = sortByLanguagePreference(uniqueResults(settled
        .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
        .map((item) => addLanguageSignals(item, languagePreference))));
      const fallback = {
        id: `fallback-${term}`,
        title: term,
        year: 'Busqueda',
        type: 'movie',
        category: 'movie',
        overview: 'No encontre una fuente gratuita directa. Puedes revisar plataformas oficiales para alquilar, comprar o reproducir con suscripcion.',
        poster: null,
        freeSources: [],
        playableSources: [],
        paidSources: officialSearchLinks(term, languagePreference),
    sourceLabel: 'Pago'
  };
      const languageFallback = addLanguageSignals(fallback, languagePreference);

      setResults(nextResults.length ? nextResults : [languageFallback]);
      setSelected(nextResults[0] || languageFallback);
      setStatus(nextResults.length ? `Encontramos ${nextResults.length} opciones priorizando ${languageProfiles[languagePreference].label}.` : 'Sin fuente gratis directa; mostrando rutas oficiales con tu preferencia de idioma.');
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function addCatalogAddon(event) {
    event.preventDefault();
    const url = addonInput.trim();
    if (!url || addonUrls.includes(url)) return;

    setStatus('Validando manifest de catalogo...');
    try {
      await loadAddon(url);
      const nextUrls = [...addonUrls, url];
      setAddonUrls(nextUrls);
      saveAddonUrls(nextUrls);
      setAddonInput('');
      setStatus('Addon de catalogo agregado. La proxima busqueda lo incluira.');
    } catch (error) {
      setStatus(error.message);
    }
  }

  function removeCatalogAddon(url) {
    const nextUrls = addonUrls.filter((candidate) => candidate !== url);
    const fallback = nextUrls.length ? nextUrls : defaultAddonUrls;
    setAddonUrls(fallback);
    saveAddonUrls(fallback);
  }

  async function preparePlayer(item) {
    setPlayer({ state: 'loading', itemId: item.id, sources: [], currentUrl: '', message: 'Buscando archivo reproducible...' });
    setStatus('Buscando fuente reproducible en navegador...');

    try {
      let sources = item.playableSources || [];
      if (!sources.length && item.archiveIdentifier) {
        sources = await getArchivePlayableSources(item.archiveIdentifier);
      }
      if (!sources.length) {
        const archiveMatch = await findArchivePlayableByTitle(item.title);
        sources = archiveMatch?.sources || [];
        if (archiveMatch) {
          setStatus(`Encontré una fuente reproducible en Internet Archive: ${archiveMatch.title || archiveMatch.identifier}.`);
        }
      }

      if (!sources.length) {
        setPlayer({
          state: 'empty',
          itemId: item.id,
          sources: [],
          currentUrl: '',
          message: 'Esta fuente no expone MP4/WebM reproducible dentro del navegador.'
        });
        setStatus('No encontré un MP4/WebM legal reproducible para este título dentro del navegador.');
        return;
      }

      const playableSources = sources.filter((source) => canPlaySource(source).allowed);
      if (!playableSources.length) {
        const firstDenied = sources[0] ? canPlaySource(sources[0]).reason : 'No hay fuentes aprobadas.';
        setPlayer({
          state: 'blocked',
          itemId: item.id,
          sources: [],
          currentUrl: '',
          message: firstDenied
        });
        setStatus(firstDenied);
        return;
      }

      setPlayer({
        state: 'ready',
        itemId: item.id,
        sources: playableSources,
        currentUrl: playableSources[0].url,
        message: `Reproduciendo ${playableSources[0].label}`
      });
      setView('watch');
      setStatus(`Reproduciendo dentro de Strimio: ${playableSources[0].label}.`);
    } catch (error) {
      setPlayer({ state: 'error', itemId: item.id, sources: [], currentUrl: '', message: error.message });
      setStatus(error.message);
    }
  }

  const active = selected || visibleResults[0] || featured[0];
  const sourceCount = results.reduce((count, item) => count + item.freeSources.length, 0);
  const paidCount = results.reduce((count, item) => count + item.paidSources.length, 0);
  const playableCount = results.filter((item) => item.archiveIdentifier || item.playableSources?.length).length;
  const registryStats = getRegistryStats();

  if (view === 'watch') {
    return (
      <main className="watch-screen">
        <header className="watch-topbar">
          <button className="secondary" type="button" onClick={() => setView('home')}><Home size={18} /> Volver al inicio</button>
          <div>
            <p className="eyebrow">Reproduciendo</p>
            <h1>{active.title}</h1>
          </div>
        </header>
        <section className="watch-player">
          {player.currentUrl ? (
            <video key={player.currentUrl} controls playsInline autoPlay poster={active.poster || undefined}>
              <source src={player.currentUrl} />
            </video>
          ) : (
            <div className="player-placeholder">
              {active.poster ? <img src={active.poster} alt="" /> : <Film size={64} />}
              <span>{player.message}</span>
            </div>
          )}
        </section>
        <footer className="watch-meta">
          <div>
            <p className="eyebrow">{active.sourceLabel || active.type}</p>
            <h2>{active.title}</h2>
            <p>{active.overview}</p>
          </div>
          <div className="quality-list">
            {player.sources.map((source) => (
              <button
                className={player.currentUrl === source.url ? 'quality active' : 'quality'}
                key={source.url}
                type="button"
                onClick={() => setPlayer({ ...player, currentUrl: source.url, message: `Reproduciendo ${source.label}` })}
              >
                {source.label}
              </button>
            ))}
          </div>
        </footer>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-icon"><Play size={18} fill="currentColor" /></span>
          <span>Strimio</span>
        </a>
        <nav className="nav-stack" aria-label="Secciones">
          {Object.entries(categories).map(([id, category]) => (
            <button
              className={activeCategory === id ? 'nav-button active' : 'nav-button'}
              key={id}
              type="button"
              onClick={() => {
                setActiveCategory(id);
                setFilter(category.type === 'all' || ['free', 'playable', 'anime'].includes(category.type) ? 'all' : category.type);
              }}
            >
              {id === 'home' && <Sparkles size={18} />}
              {id === 'movie' && <Film size={18} />}
              {id === 'series' && <Tv size={18} />}
              {id === 'anime' && <Clapperboard size={18} />}
              {id === 'free' && <ShieldCheck size={18} />}
              {id === 'playable' && <Play size={18} />}
              <span>{category.label}</span>
            </button>
          ))}
        </nav>
        <div className="language-panel">
          <span>Prioridad idioma</span>
          {Object.entries(languageProfiles).map(([id, profile]) => (
            <button
              className={languagePreference === id ? 'language-option active' : 'language-option'}
              key={id}
              type="button"
              onClick={() => setLanguagePreference(id)}
            >
              {profile.short}
            </button>
          ))}
        </div>
        <form className="addon-form" onSubmit={addCatalogAddon}>
          <label>
            <span>Manifest catalogo</span>
            <input value={addonInput} onChange={(event) => setAddonInput(event.target.value)} placeholder="https://.../manifest.json" />
          </label>
          <button className="secondary full" type="submit"><PackagePlus size={16} /> Agregar</button>
        </form>
        <div className="addon-list">
          {addonUrls.map((url) => (
            <button key={url} type="button" onClick={() => removeCatalogAddon(url)} title={url}>
              {getAddonLabel(url)}
            </button>
          ))}
        </div>
        <div className="sidebar-note">
          <ShieldCheck size={18} />
          <p>Providers tipo Torrentio: si la fuente esta en allowlist legal, se reproduce aqui. Si no esta verificada, queda como catalogo.</p>
        </div>
        <div className="registry-card">
          <strong>SourceRegistry</strong>
          <span>{registryStats.playable}/{registryStats.total} providers reproducibles</span>
          <small>{Object.values(legalSources).map((source) => source.providerName).join(', ')}</small>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <form className="search" onSubmit={runSearch}>
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar pelicula, serie o anime" />
            <button className="search-submit" type="submit" disabled={loading}>{loading ? 'Buscando' : 'Buscar'}</button>
          </form>
        </header>

        <section className="hero catalog-hero">
          <div className="hero-copy">
            <p className="eyebrow">Ahora en portada</p>
            <h1>{active.title}</h1>
            <div className="hero-meta">
              <span>{active.year}</span>
              <span>{active.sourceLabel || active.type}</span>
              <span>{active.archiveIdentifier ? 'Player interno' : 'Catalogo'}</span>
            </div>
            <p>{status}</p>
            <div className="language-summary">
              <span>{languageProfiles[languagePreference].short}</span>
              <small>{languageProfiles[languagePreference].sourceHint}</small>
            </div>
            <div className="actions">
              <button className="primary" type="button" onClick={() => preparePlayer(active)}><Play size={18} /> Reproducir aqui</button>
              <button className="secondary" type="button" onClick={runSearch}><Search size={18} /> Buscar ahora</button>
              <a className="secondary link-button" href="https://archive.org/details/movies" target="_blank" rel="noreferrer"><Globe2 size={18} /> Explorar IA</a>
            </div>
          </div>
          <div className="hero-preview">
            {active.poster ? <img src={active.poster} alt="" /> : (
              <div className="preview-window">
                <Clapperboard size={54} />
                <span>{sourceCount} fuentes gratis</span>
              </div>
            )}
          </div>
        </section>

        <section className="section-title">
          <div>
            <p className="eyebrow">Resultados</p>
            <h2>Catalogo unificado</h2>
          </div>
          <div className="filters" role="group" aria-label="Filtros">
            {[
              ['all', 'Todo', Clapperboard],
              ['movie', 'Pelis', Film],
              ['series', 'Series', Tv],
              ['anime', 'Anime', Clapperboard],
              ['collection', 'Colecciones', Globe2]
            ].map(([id, label, Icon]) => (
              <button key={id} className={filter === id ? 'chip active' : 'chip'} type="button" onClick={() => setFilter(id)}>
                <Icon size={16} /> {label}
              </button>
            ))}
          </div>
        </section>

        <section className="grid" aria-live="polite">
          {visibleResults.map((item) => (
            <button
              className={active.id === item.id ? 'media-card selected' : 'media-card'}
              key={item.id}
              type="button"
              onClick={() => setSelected(item)}
            >
              <span className="poster">
                {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <span>{item.title.charAt(0).toUpperCase()}</span>}
                <small className={item.archiveIdentifier || item.playableSources?.length ? 'play-badge ready' : 'play-badge'}>
                  {item.archiveIdentifier || item.playableSources?.length ? 'PLAY' : 'INFO'}
                </small>
              </span>
              <span className="card-title">{item.title}</span>
              <span className="card-meta">{item.year} · {item.sourceLabel || item.type} · {item.languageLabel || languageProfiles[languagePreference].short}</span>
            </button>
          ))}
        </section>
      </section>

      <aside className="player-panel">
        <div className="browser-player">
          {player.currentUrl ? (
            <video key={player.currentUrl} controls playsInline autoPlay poster={active.poster || undefined}>
              <source src={player.currentUrl} />
            </video>
          ) : (
            <div className="player-placeholder">
              {active.poster ? <img src={active.poster} alt="" /> : <Film size={64} />}
              <span>{player.message}</span>
            </div>
          )}
        </div>

        <section className="details">
          <p className="eyebrow">{active.type}</p>
          <h2>{active.title}</h2>
          <p>{active.overview}</p>
          <div className="match-pill">{active.languageMatch || languageProfiles[languagePreference].sourceHint}</div>
          <div className="actions compact">
            <button className="primary" type="button" onClick={() => preparePlayer(active)}><Play size={18} /> Reproducir aqui</button>
            <button className="secondary" type="button" onClick={() => setPlayer({ state: 'idle', itemId: null, sources: [], currentUrl: '', message: 'Reproductor detenido.' })}><PauseCircle size={18} /> Detener</button>
          </div>
          {player.sources.length > 1 && (
            <div className="quality-list">
              {player.sources.map((source) => (
                <button
                  className={player.currentUrl === source.url ? 'quality active' : 'quality'}
                  key={source.url}
                  type="button"
                  onClick={() => setPlayer({ ...player, currentUrl: source.url, message: `Reproduciendo ${source.label}` })}
                >
                  {source.label}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="source-block">
          <h3><ShieldCheck size={18} /> Gratis legal</h3>
          {active.freeSources.length ? active.freeSources.map((source) => (
            <a className="source-link free" key={`${source.name}-${source.url}`} href={source.url} target="_blank" rel="noreferrer">
              <span><strong>{source.name}</strong><small>{source.kind} · {source.language || 'Idioma variable'}</small></span>
              <ExternalLink size={16} />
            </a>
          )) : <p className="quiet">No hay fuente gratis directa confirmada para este resultado.</p>}
        </section>

        <section className="source-block">
          <h3><BadgeDollarSign size={18} /> Plataformas oficiales</h3>
          {active.paidSources.length ? active.paidSources.slice(0, 8).map((source) => (
            <a className="source-link paid" key={`${source.name}-${source.url}`} href={source.url} target="_blank" rel="noreferrer">
              <span><strong>{source.name}</strong><small>{source.kind || 'Buscar / pagar'} · {source.language || languageProfiles[languagePreference].sourceHint}</small></span>
              <ExternalLink size={16} />
            </a>
          )) : <p className="quiet">Agrega `VITE_TMDB_TOKEN` para disponibilidad por plataforma via TMDB.</p>}
        </section>

        <section className="telemetry">
          <div><ShieldCheck size={18} /><strong>{sourceCount}</strong><span>Fuentes gratis</span></div>
          <div><Play size={18} /><strong>{playableCount}</strong><span>Reproducibles</span></div>
          <div><WalletCards size={18} /><strong>{paidCount}</strong><span>Rutas oficiales</span></div>
        </section>
      </aside>
    </main>
  );
}

export default App;
