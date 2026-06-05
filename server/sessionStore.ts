import type { PlaybackOption, StreamSession } from './types.js';

const sessions = new Map<string, StreamSession>();

function keyFor(infoHash: string, fileIdx = 0) {
  return `${infoHash.toLowerCase()}:${fileIdx}`;
}

export function authorizePlayback(option: PlaybackOption, imdbId?: string) {
  if (!option.infoHash) return;

  const fileIdx = option.fileIdx ?? 0;
  sessions.set(keyFor(option.infoHash, fileIdx), {
    infoHash: option.infoHash,
    fileIdx,
    imdbId,
    filename: option.title,
    title: option.title,
    authorizedAt: Date.now()
  });
}

export function getAuthorizedSession(infoHash: string, fileIdx = 0) {
  return sessions.get(keyFor(infoHash, fileIdx));
}

export function isHashAuthorized(infoHash: string, fileIdx = 0) {
  return Boolean(getAuthorizedSession(infoHash, fileIdx));
}
