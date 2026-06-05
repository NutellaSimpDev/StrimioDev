import { Router } from 'express';

const router = Router();
const tmdbBaseUrl = 'https://api.themoviedb.org/3';
const tmdbImageBaseUrl = 'https://image.tmdb.org/t/p/w500';

type TmdbMovie = {
  id: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  media_type?: string;
};

type TmdbExternalIds = {
  imdb_id?: string | null;
};

type CatalogItem = {
  tmdbId: number;
  imdbId: string;
  title: string;
  mediaType: 'movie' | 'series' | 'anime';
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string;
  vote_average: number;
  release_date: string | null;
  episodeCount?: number | null;
};

function getTmdbToken() {
  const token = process.env.TMDB_BEARER_TOKEN;
  if (!token) {
    throw new Error('Falta TMDB_BEARER_TOKEN en .env.');
  }
  return token;
}

async function tmdbFetch<T>(path: string, params: Record<string, string> = {}) {
  const url = new URL(`${tmdbBaseUrl}${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${getTmdbToken()}`,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`TMDB respondio ${response.status} para ${path}.`);
  }

  return response.json() as Promise<T>;
}

async function getMovieExternalIds(tmdbId: number) {
  return tmdbFetch<TmdbExternalIds>(`/movie/${tmdbId}/external_ids`);
}

async function getTvExternalIds(tmdbId: number) {
  return tmdbFetch<TmdbExternalIds>(`/tv/${tmdbId}/external_ids`);
}

function imageUrl(path?: string | null) {
  return path ? `${tmdbImageBaseUrl}${path}` : null;
}

async function normalizeMovie(movie: TmdbMovie): Promise<CatalogItem | null> {
  const externalIds = await getMovieExternalIds(movie.id);
  if (!externalIds.imdb_id) return null;

  return {
    tmdbId: movie.id,
    imdbId: externalIds.imdb_id,
    title: movie.title || movie.name || `TMDB ${movie.id}`,
    mediaType: 'movie',
    poster_path: imageUrl(movie.poster_path),
    backdrop_path: imageUrl(movie.backdrop_path),
    overview: movie.overview || '',
    vote_average: Number(movie.vote_average || 0),
    release_date: movie.release_date || null
  };
}

async function normalizeSeries(show: TmdbMovie): Promise<CatalogItem | null> {
  const externalIds = await getTvExternalIds(show.id);
  if (!externalIds.imdb_id) return null;

  return {
    tmdbId: show.id,
    imdbId: externalIds.imdb_id,
    title: show.name || show.title || `TMDB ${show.id}`,
    mediaType: 'series',
    poster_path: imageUrl(show.poster_path),
    backdrop_path: imageUrl(show.backdrop_path),
    overview: show.overview || '',
    vote_average: Number(show.vote_average || 0),
    release_date: show.first_air_date || show.release_date || null
  };
}

async function fetchSeriesCatalog() {
  const data = await tmdbFetch<{ results?: TmdbMovie[] }>('/trending/tv/week', { language: 'es-ES' });
  const shows = (data.results || []).slice(0, 20);
  const settled = await Promise.allSettled(shows.map(normalizeSeries));

  return settled.flatMap((result) => {
    if (result.status !== 'fulfilled' || !result.value) return [];
    return [result.value];
  });
}

async function fetchAnimeCatalog() {
  const response = await fetch('https://api.jikan.moe/v4/top/anime?filter=airing&sfw=true&limit=20', {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Jikan respondio ${response.status}.`);
  const data = await response.json() as {
    data?: Array<{
      mal_id: number;
      title_english?: string;
      title?: string;
      images?: { jpg?: { large_image_url?: string; image_url?: string } };
      synopsis?: string;
      score?: number;
      episodes?: number | null;
    }>;
  };

  return (data.data || []).map((item): CatalogItem => ({
    tmdbId: item.mal_id,
    imdbId: `mal-${item.mal_id}`,
    title: item.title_english || item.title || `Anime ${item.mal_id}`,
    mediaType: 'anime',
    poster_path: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || null,
    backdrop_path: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || null,
    overview: item.synopsis || '',
    vote_average: Number(item.score || 0),
    release_date: null,
    episodeCount: item.episodes || null
  }));
}

async function fetchCatalog(path: string) {
  const data = await tmdbFetch<{ results?: TmdbMovie[] }>(path, { language: 'es-ES' });
  const movies = (data.results || []).slice(0, 20);
  const settled = await Promise.allSettled(movies.map(normalizeMovie));

  return settled.flatMap((result) => {
    if (result.status !== 'fulfilled' || !result.value) return [];
    return [result.value];
  });
}

async function searchCatalog(query: string) {
  const data = await tmdbFetch<{ results?: TmdbMovie[] }>('/search/movie', {
    language: 'es-ES',
    query,
    include_adult: 'false'
  });
  const movies = (data.results || []).slice(0, 24);
  const settled = await Promise.allSettled(movies.map(normalizeMovie));

  return settled.flatMap((result) => {
    if (result.status !== 'fulfilled' || !result.value) return [];
    return [result.value];
  });
}

router.get('/trending', async (_req, res) => {
  try {
    res.json(await fetchCatalog('/trending/movie/week'));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/latest', async (_req, res) => {
  try {
    res.json(await fetchCatalog('/movie/now_playing'));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/series', async (_req, res) => {
  try {
    res.json(await fetchSeriesCatalog());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/anime', async (_req, res) => {
  try {
    res.json(await fetchAnimeCatalog());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) {
      res.json([]);
      return;
    }

    res.json(await searchCatalog(query));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;

export const seriesRouter = Router();

seriesRouter.get('/:id', async (req, res) => {
  try {
    const tmdbId = Number(req.params.id);
    const seasonNumber = req.query.season ? Number(req.query.season) : null;

    if (seasonNumber) {
      const season = await tmdbFetch<{
        id: number;
        name?: string;
        season_number: number;
        episodes?: Array<{ id: number; episode_number: number; name?: string; overview?: string; still_path?: string | null }>;
      }>(`/tv/${tmdbId}/season/${seasonNumber}`, { language: 'es-ES' });
      res.json({
        id: season.id,
        name: season.name || `Temporada ${seasonNumber}`,
        seasonNumber: season.season_number,
        episodes: (season.episodes || []).map((episode) => ({
          id: episode.id,
          episodeNumber: episode.episode_number,
          title: episode.name || `Episodio ${episode.episode_number}`,
          overview: episode.overview || '',
          still_path: imageUrl(episode.still_path)
        }))
      });
      return;
    }

    const show = await tmdbFetch<{
      id: number;
      name?: string;
      overview?: string;
      number_of_seasons?: number;
      seasons?: Array<{ id: number; name?: string; season_number: number; episode_count: number; poster_path?: string | null }>;
    }>(`/tv/${tmdbId}`, { language: 'es-ES' });

    res.json({
      id: show.id,
      title: show.name || `Serie ${tmdbId}`,
      overview: show.overview || '',
      numberOfSeasons: show.number_of_seasons || 0,
      seasons: (show.seasons || [])
        .filter((season) => season.season_number > 0 && season.episode_count > 0)
        .map((season) => ({
          id: season.id,
          name: season.name || `Temporada ${season.season_number}`,
          seasonNumber: season.season_number,
          episodeCount: season.episode_count,
          poster_path: imageUrl(season.poster_path)
        }))
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
