export type PlaybackOption = {
  provider: string;
  providerId: string;
  sourceKind: 'torrent' | 'http' | 'direct' | 'metadata';
  title: string;
  quality: string;
  server: string | null;
  url: string | null;
  infoHash: string | null;
  fileIdx: number | null;
  headers: Record<string, string>;
  subtitles: unknown[];
  authorized: boolean;
  blockedReason: string | null;
};

export type ResolveResponse = {
  query: Record<string, unknown>;
  count: number;
  playableCount: number;
  options: PlaybackOption[];
  errors: string[];
};

export type StreamSession = {
  infoHash: string;
  fileIdx: number;
  imdbId?: string;
  filename?: string;
  title?: string;
  authorizedAt: number;
};

export type SubtitleResult = {
  id: string;
  lang: string;
  label: string;
  provider: string;
  url: string;
};
