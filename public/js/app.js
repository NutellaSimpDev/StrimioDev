/* global Plyr, Hls */

const endpoints = {
  trending: '/api/catalog/trending',
  latest: '/api/catalog/latest',
  series: '/api/catalog/series',
  anime: '/api/catalog/anime',
  search: '/api/catalog/search'
};

let player = null;

const els = {
  rows: {
    trending: document.getElementById('trendingRow'),
    latest: document.getElementById('latestRow'),
    series: document.getElementById('seriesRow'),
    anime: document.getElementById('animeRow')
  },
  status: {
    trending: document.getElementById('trendingStatus'),
    latest: document.getElementById('latestStatus'),
    series: document.getElementById('seriesStatus'),
    anime: document.getElementById('animeStatus')
  },
  searchInput: document.getElementById('searchInput'),
  clearSearch: document.getElementById('clearSearch'),
  searchSection: document.getElementById('searchSection'),
  catalogSections: document.getElementById('catalogSections'),
  searchGrid: document.getElementById('searchGrid'),
  searchTitle: document.getElementById('searchTitle'),
  searchStatus: document.getElementById('searchStatus'),
  heroBackdrop: document.getElementById('heroBackdrop'),
  modal: document.getElementById('playerModal'),
  modalTitle: document.getElementById('modalTitle'),
  modalStatus: document.getElementById('modalStatus'),
  movieOverview: document.getElementById('movieOverview'),
  loadingOverlay: document.getElementById('loadingOverlay'),
  loadingTitle: document.getElementById('loadingTitle'),
  loadingDetail: document.getElementById('loadingDetail'),
  loadingProgress: document.getElementById('loadingProgress'),
  loadingPercent: document.getElementById('loadingPercent'),
  loadingRing: document.getElementById('loadingRing'),
  get video() {
    return player?.media || document.getElementById('modalVideo');
  },
  qualityList: document.getElementById('qualityList'),
  qualityCount: document.getElementById('qualityCount'),
  audioSelect: document.getElementById('audioSelect'),
  audioStatus: document.getElementById('audioStatus'),
  subtitleSelect: document.getElementById('subtitleSelect'),
  subtitleStatus: document.getElementById('subtitleStatus'),
  closeModal: document.getElementById('closeModal'),
  skeleton: document.getElementById('qualitySkeleton'),
  episodeModal: document.getElementById('episodeModal'),
  episodeEyebrow: document.getElementById('episodeEyebrow'),
  episodeTitle: document.getElementById('episodeTitle'),
  closeEpisodeModal: document.getElementById('closeEpisodeModal'),
  seasonLabel: document.getElementById('seasonLabel'),
  seasonSelect: document.getElementById('seasonSelect'),
  episodeGrid: document.getElementById('episodeGrid')
};

let customDuration = 0;
let currentStartTime = 0;

const originalDurationDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration');
Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
  get() {
    if (customDuration > 0 && (this === els.video || this.id === 'modalVideo' || this.id === 'player')) {
      return customDuration;
    }
    return originalDurationDescriptor.get.call(this);
  },
  configurable: true
});

const originalCurrentTimeDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
  get() {
    if (currentStartTime > 0 && (this === els.video || this.id === 'modalVideo' || this.id === 'player')) {
      return currentStartTime + originalCurrentTimeDescriptor.get.call(this);
    }
    return originalCurrentTimeDescriptor.get.call(this);
  },
  set(val) {
    const isTranscoded = activePlaybackOption?.infoHash && shouldTranscode(activePlaybackOption);
    if (isTranscoded && currentStartTime > 0 && val === 0) {
      originalCurrentTimeDescriptor.set.call(this, 0);
      return;
    }
    if (isTranscoded) {
      const currentDisplayTime = currentStartTime + originalCurrentTimeDescriptor.get.call(this);
      if (Math.abs(val - currentDisplayTime) > 1.5) {
        currentStartTime = val;
        scheduleStreamSeek(val);
        originalCurrentTimeDescriptor.set.call(this, 0);
        return;
      }
    }
    originalCurrentTimeDescriptor.set.call(this, val);
  },
  configurable: true
});

function setOverrideDuration(duration) {
  customDuration = duration;
  const video = els.video;
  if (video) video.dispatchEvent(new Event('durationchange'));
}

player = new Plyr(els.video, {
  captions: { active: true, language: 'es', update: true },
  controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'captions', 'settings', 'fullscreen']
});

let searchTimer = null;
let activeMovie = null;
let statsTimer = null;
let statsPollGeneration = 0;
let hls = null;
let activePlaybackOption = null;
let lastObservedTime = 0;
let selectedAudioTrack = 0;
let cachedCompiledTracks = [];
let cachedAudioTracks = [];
let trackSwapTimeRestorationListener = null;
let seekDebounceTimer = null;
let pendingSeekTime = null;

function setStatus(section, message) {
  els.status[section].textContent = message;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function movieCard(movie, compact = false) {
  const button = document.createElement('button');
  button.className = `${compact ? 'w-full' : 'w-32 sm:w-48'} group snap-start shrink-0 text-left transition-all duration-300 hover:scale-105`;
  button.type = 'button';
  button.title = movie.title;
  button.innerHTML = `
    <div class="overflow-hidden rounded-lg border border-white/10 bg-zinc-900 shadow-xl transition duration-300 group-hover:border-red-500/70">
      ${movie.poster_path
        ? `<img class="aspect-[2/3] w-full object-cover" src="${movie.poster_path}" alt="${escapeHtml(movie.title)}" loading="lazy" />`
        : `<div class="grid aspect-[2/3] w-full place-items-center bg-zinc-900 text-4xl font-black text-zinc-700">${escapeHtml(movie.title.charAt(0))}</div>`}
    </div>
    <strong class="mt-3 block truncate text-sm font-black text-zinc-100">${escapeHtml(movie.title)}</strong>
    <span class="block text-xs text-zinc-500">${movie.mediaType || 'movie'} · ${movie.imdbId} · ${Number(movie.vote_average || 0).toFixed(1)}</span>
  `;
  button.addEventListener('click', () => handleCatalogClick(movie));
  return button;
}

function handleCatalogClick(item) {
  if (item.mediaType === 'series') {
    openSeriesSelector(item);
    return;
  }

  if (item.mediaType === 'anime') {
    openAnimeSelector(item);
    return;
  }

  openMovie(item);
}

async function loadSection(section) {
  setStatus(section, 'Cargando...');
  els.rows[section].innerHTML = '';

  try {
    const response = await fetch(endpoints[section]);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error de catálogo.');

    if (section === 'trending' && data[0]?.backdrop_path) {
      els.heroBackdrop.style.backgroundImage = `url(${data[0].backdrop_path.replace('/w500/', '/original/')})`;
    }

    data.forEach((movie) => els.rows[section].appendChild(movieCard(movie)));
    setStatus(section, `${data.length} títulos`);
  } catch (error) {
    setStatus(section, error.message);
  }
}

function renderSkeletons() {
  els.qualityList.innerHTML = '';
  for (let index = 0; index < 5; index += 1) {
    els.qualityList.appendChild(els.skeleton.content.cloneNode(true));
  }
  els.qualityCount.textContent = '...';
}

function parseSize(title) {
  return title.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i)?.[0] || 'N/D';
}

function parseSeeds(title) {
  return title.match(/👤\s*(\d+)/)?.[1] || '0';
}

function parseTracker(title) {
  return title.match(/⚙️\s*([^\n]+)/)?.[1]?.trim() || 'Torrent';
}

function parseAudioCodec(title = '') {
  if (/\b(TrueHD|MLP)\b/i.test(title)) return { label: 'TrueHD', compatible: false };
  if (/\b(Atmos)\b/i.test(title)) return { label: 'Atmos', compatible: false };
  if (/\b(DTS|DTS-HD|DTSHD)\b/i.test(title)) return { label: 'DTS', compatible: false };
  if (/\b(DDP|DD\+|E-?AC-?3|AC-?3|Dolby)\b/i.test(title)) return { label: 'Dolby', compatible: false };
  if (/\b(AAC|MP4A)\b/i.test(title)) return { label: 'AAC', compatible: true };
  if (/\b(MP3|Opus|Vorbis)\b/i.test(title)) return { label: title.match(/\b(MP3|Opus|Vorbis)\b/i)?.[0] || 'Audio web', compatible: true };
  return { label: 'Audio ?', compatible: null };
}

function playbackCompatibility(option) {
  const text = `${option.title || ''} ${option.url || ''}`;
  const audio = parseAudioCodec(text);
  const isMkv = /\.mkv\b/i.test(text);
  const isDirect = Boolean(option.url);
  const score = (isDirect ? 3 : 0) + (audio.compatible === true ? 4 : 0) - (audio.compatible === false ? 6 : 0) - (isMkv ? 2 : 0);
  return { ...audio, isMkv, score };
}

function isLikelyHdrOption(option) {
  return /\b(HDR10\+?|HDR|DV|DOVI|Dolby\s*Vision|HLG|PQ|BT\.?2020|Rec\.?2020)\b/i.test(option?.title || '');
}

function shouldUseHdrDirect(option) {
  const text = `${option?.title || ''} ${option?.url || ''}`;
  return Boolean(option?.infoHash && isLikelyHdrOption(option) && !/\.mkv\b/i.test(text));
}

function playbackMimeForOption(option) {
  const text = `${option?.title || ''} ${option?.url || ''}`;
  if (/\.webm\b/i.test(text)) return 'video/webm';
  if (/\.mkv\b/i.test(text)) return 'video/x-matroska';
  return 'video/mp4';
}

function streamUrlForOption(option, audioTrack = selectedAudioTrack, startTime = 0) {
  const params = new URLSearchParams({ fileIdx: String(option.fileIdx ?? 0) });
  if (option.infoHash) {
    if (shouldUseHdrDirect(option)) {
      return `/api/stream/${option.infoHash}?${params}`;
    }
    params.set('audioTrack', String(audioTrack));
    if (startTime > 0) {
      params.set('startTime', String(startTime));
    }
    return `/api/transcode/${option.infoHash}?${params}`;
  }
  return `/api/stream/${option.infoHash || option.url}?${params}`;
}

function formatClock(totalSeconds = 0) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function setLoadingPercent(percent) {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  if (els.loadingPercent) els.loadingPercent.textContent = `${Math.round(safe)}%`;
  if (els.loadingRing) els.loadingRing.style.setProperty('--loading-deg', `${Math.max(14, safe * 3.6)}deg`);
  if (els.loadingProgress) els.loadingProgress.style.width = `${safe}%`;
}

function bufferedAheadSeconds() {
  const video = els.video;
  if (!video?.buffered?.length) return 0;

  const current = originalCurrentTimeDescriptor.get.call(video) || 0;
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    if (start <= current + 0.25 && end >= current) {
      return Math.max(0, end - current);
    }
  }

  return 0;
}

function playbackBufferPercent() {
  const targetSeconds = 20;
  return Math.min(100, (bufferedAheadSeconds() / targetSeconds) * 100);
}

function scheduleStreamSeek(time) {
  if (!activePlaybackOption) return;
  pendingSeekTime = Math.max(0, Math.min(customDuration || time, time));
  clearTimeout(seekDebounceTimer);
  seekDebounceTimer = setTimeout(() => {
    const target = pendingSeekTime;
    pendingSeekTime = null;
    reloadStreamAtTime(target);
  }, 160);
}

function subtitleUrlForPlayback(src, startTime = currentStartTime) {
  if (!src || startTime <= 0 || !shouldTranscode(activePlaybackOption)) return src;
  try {
    const url = new URL(src, window.location.origin);
    if (url.origin === window.location.origin) {
      url.searchParams.set('offset', String(startTime));
      return `${url.pathname}${url.search}`;
    }
  } catch {
    // Keep original source if it is not a normal URL.
  }
  return src;
}

function applyTrackSourcesForCurrentStart() {
  if (!cachedCompiledTracks.length) return;
  clearTracks();
  cachedCompiledTracks.forEach((track, index) => {
    const trackEl = document.createElement('track');
    trackEl.kind = track.kind;
    trackEl.label = track.label;
    trackEl.srclang = track.srclang;
    trackEl.dataset.baseSrc = track.src;
    trackEl.src = subtitleUrlForPlayback(track.src);
    if (index === 0) trackEl.default = true;
    els.video.appendChild(trackEl);
  });
}

function reloadStreamAtTime(time) {
  if (!activePlaybackOption) return;
  
  if (trackSwapTimeRestorationListener) {
    els.video.removeEventListener('loadedmetadata', trackSwapTimeRestorationListener);
    trackSwapTimeRestorationListener = null;
  }
  
  els.modalStatus.textContent = `Saltando a ${formatClock(time)}...`;
  
  player.source = {
    type: 'video',
    title: activePlaybackOption.title,
    sources: [
      {
        src: streamUrlForOption(activePlaybackOption, selectedAudioTrack, time),
        type: playbackMimeForOption(activePlaybackOption)
      }
    ],
    tracks: cachedCompiledTracks.map((track) => ({
      ...track,
      src: subtitleUrlForPlayback(track.src, time)
    }))
  };
  applyTrackSourcesForCurrentStart();

  setTimeout(() => {
    setupPlyrAudioMenu(player, cachedAudioTracks, selectedAudioTrack, (trackIdx) => {
      selectedAudioTrack = trackIdx;
      els.audioSelect.value = String(trackIdx);
      els.audioStatus.textContent = `Cambiando a pista de audio ${trackIdx}...`;
      playOption(activePlaybackOption, document.querySelector('[data-quality-card].border-red-500') || document.body, { keepTrackControls: true, audioTrack: trackIdx });
    });
  }, 200);

  player.play().catch(() => {});
}

function pickAutoplayIndex(options) {
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  options.forEach((option, index) => {
    const candidate = playbackCompatibility(option).score - (index * 0.01);
    if (candidate > bestScore) {
      bestIndex = index;
      bestScore = candidate;
    }
  });
  return bestIndex;
}

function cleanTitle(title) {
  return title.split('\n')[0] || title;
}

function clearTracks() {
  [...els.video.querySelectorAll('track')].forEach((track) => track.remove());
}

function destroyHls() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
}

function resetVideoElement() {
  hideLoadingOverlay();
  setOverrideDuration(0);
  try {
    player.stop();
  } catch {
    els.video.pause();
  }
  els.video.removeAttribute('src');
  els.video.load();
}

function resetTrackControls() {
  clearTracks();
  selectedAudioTrack = 0;
  els.subtitleSelect.innerHTML = '<option value="off">Sin subtítulos</option>';
  els.subtitleSelect.value = 'off';
  els.subtitleSelect.disabled = true;
  els.subtitleStatus.textContent = 'Buscando subtítulos lat/spa/eng...';

  els.audioSelect.innerHTML = '<option value="auto">Audio original</option>';
  els.audioSelect.disabled = true;
  els.audioStatus.textContent = 'Detectando pistas de audio...';
}

function shouldTranscode(option) {
  return Boolean(option?.infoHash && !shouldUseHdrDirect(option));
}

function syncPlyrCaptionState(selectedIndex) {
  if (!player) return;
  try {
    if (selectedIndex < 0) {
      player.toggleCaptions(false);
      return;
    }
    player.currentTrack = selectedIndex;
    player.toggleCaptions(true);
  } catch {
    // Native textTracks still control captions if Plyr refuses the assignment.
  }
}

function setSubtitleMode(selectedIndex) {
  const tracks = els.video.textTracks || [];
  for (let index = 0; index < tracks.length; index += 1) {
    tracks[index].mode = index === selectedIndex ? 'showing' : 'disabled';
  }
  syncPlyrCaptionState(selectedIndex);
  if (selectedIndex < 0) {
    els.subtitleStatus.textContent = 'Subtítulos desactivados.';
  } else {
    const label = cachedCompiledTracks[selectedIndex]?.label || els.subtitleSelect.selectedOptions[0]?.textContent || 'subtítulo seleccionado';
    els.subtitleStatus.textContent = `Subtítulos: ${label}.`;
  }
}


function nativeAudioTracks() {
  return els.video.audioTracks && Number.isFinite(els.video.audioTracks.length)
    ? els.video.audioTracks
    : null;
}

function labelForAudioTrack(track, index) {
  const parts = [track.label, track.language, track.kind].filter(Boolean);
  return parts.length ? parts.join(' · ') : `Pista ${index + 1}`;
}

function preferredAudioIndex(audioTracks) {
  const preferred = audioTracks.find((track) => {
    const text = `${track.label || ''} ${track.language || ''} ${track.title || ''}`.toLowerCase();
    return /\b(lat|la|latin|latino|spa|es|esp|spanish|español|castellano)\b/i.test(text);
  });
  return preferred?.index ?? audioTracks[0]?.index ?? 0;
}


function refreshAudioTracks() {
  if (hls?.audioTracks?.length) {
    els.audioSelect.innerHTML = hls.audioTracks.map((track, index) => {
      const label = track.name || track.lang || `Pista ${index + 1}`;
      return `<option value="${index}">${escapeHtml(label)}</option>`;
    }).join('');
    els.audioSelect.disabled = hls.audioTracks.length < 2;
    els.audioSelect.value = String(Math.max(0, hls.audioTrack));
    els.audioStatus.textContent = hls.audioTracks.length > 1
      ? `${hls.audioTracks.length} pistas HLS disponibles.`
      : 'Una pista HLS disponible.';
    els.audioSelect.onchange = () => {
      hls.audioTrack = Number(els.audioSelect.value);
      els.audioStatus.textContent = `Audio: ${els.audioSelect.selectedOptions[0]?.textContent || 'pista seleccionada'}.`;
    };
    return;
  }

  const tracks = nativeAudioTracks();
  if (!tracks || tracks.length === 0) {
    const compatibility = activePlaybackOption ? playbackCompatibility(activePlaybackOption) : null;
    if (activePlaybackOption?.infoHash && shouldTranscode(activePlaybackOption)) return;

    els.audioSelect.innerHTML = '<option value="auto">Audio original</option>';
    els.audioSelect.disabled = true;
    els.audioStatus.textContent = compatibility?.compatible === false
      ? `La fuente usa ${compatibility.label}; Brave/Chrome pueden reproducir video sin audio. Elige una fuente AAC/MP4 o transcodifica audio en backend.`
      : 'Este navegador no expone pistas de audio para este contenedor. Si es MKV dual/triple audio, hará falta transcodificación o remux en backend.';
    return;
  }

  els.audioSelect.innerHTML = Array.from(tracks).map((track, index) => {
    return `<option value="${index}">${escapeHtml(labelForAudioTrack(track, index))}</option>`;
  }).join('');
  els.audioSelect.disabled = tracks.length < 2;
  els.audioStatus.textContent = tracks.length > 1 ? `${tracks.length} pistas de audio detectadas.` : 'Una pista de audio detectada.';
  els.audioSelect.value = String(Array.from(tracks).findIndex((track) => track.enabled) || 0);
  els.audioSelect.onchange = () => {
    const selected = Number(els.audioSelect.value);
    Array.from(tracks).forEach((track, index) => {
      track.enabled = index === selected;
    });
    els.audioStatus.textContent = `Audio: ${els.audioSelect.selectedOptions[0]?.textContent || 'pista seleccionada'}.`;
  };
}


function showLoadingOverlay(message = 'Conectando a los peers...', detail = 'Preparando buffer inicial.', resetProgress = false) {
  els.loadingTitle.textContent = message;
  els.loadingDetail.textContent = detail;
  if (resetProgress) {
    setLoadingPercent(0);
  }
  els.loadingOverlay.classList.add('visible');
}

function hideLoadingOverlay() {
  statsPollGeneration += 1;
  els.loadingOverlay.classList.remove('visible');
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

function maybeHideOverlayForPlayback() {
  if (els.loadingOverlay.classList.contains('visible')) {
    setLoadingPercent(playbackBufferPercent());
  }
  const advanced = els.video.currentTime > 0 && els.video.currentTime !== lastObservedTime;
  lastObservedTime = els.video.currentTime;
  if (els.video.readyState >= 3 || (!els.video.paused && (els.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || advanced))) {
    hideLoadingOverlay();
  }
}

async function pollTorrentStats(option) {
  if (statsTimer) clearInterval(statsTimer);
  const pollGeneration = ++statsPollGeneration;

  const update = async () => {
    if (pollGeneration !== statsPollGeneration || activePlaybackOption !== option) return;
    try {
      const params = new URLSearchParams({ fileIdx: String(option.fileIdx ?? 0) });
      const response = await fetch(`/api/stream/stats/${option.infoHash}?${params}`);
      const stats = await response.json();
      if (pollGeneration !== statsPollGeneration || activePlaybackOption !== option) return;
      if (!response.ok) throw new Error(stats.error || 'No se pudieron leer estadisticas.');

      const bufferAhead = bufferedAheadSeconds();
      const bufferPercent = playbackBufferPercent();
      setLoadingPercent(bufferPercent);
      const fileLabel = stats.file
        ? `Archivo: ${stats.file.progress}% (${stats.file.downloadedSize}/${stats.file.size})`
        : `Torrent: ${stats.progress}%`;
      if (!stats.numPeers) {
        els.loadingTitle.textContent = 'Conectando a los peers...';
        els.loadingDetail.textContent = `${fileLabel} · Buffer local: ${bufferAhead.toFixed(1)}s · ${stats.downloadSpeed} · sin peers`;
        return;
      }

      els.loadingTitle.textContent = 'Buffering inicial...';
      els.loadingDetail.textContent = `${fileLabel} · Buffer local: ${bufferAhead.toFixed(1)}s · ${stats.downloadSpeed} · ${stats.numPeers} peers`;
    } catch (error) {
      els.loadingTitle.textContent = 'Esperando datos del torrent...';
      els.loadingDetail.textContent = error.message;
    }
  };

  await update();
  statsTimer = setInterval(update, 1000);
}

function stopTorrentForOption(option) {
  if (!option?.infoHash) return;
  fetch(`/api/stream/stop/${encodeURIComponent(option.infoHash)}`, { method: 'POST' }).catch(() => {});
}

async function playOption(option, card, settings = {}) {
  const currentTime = els.video.currentTime || 0;
  const previousPlaybackOption = activePlaybackOption;
  
  document.querySelectorAll('[data-quality-card]').forEach((node) => {
    node.classList.remove('border-red-500', 'bg-red-500/10');
  });
  card.classList.add('border-red-500', 'bg-red-500/10');
  
  destroyHls();
  if (!settings.keepTrackControls && previousPlaybackOption?.infoHash && previousPlaybackOption.infoHash !== option.infoHash) {
    stopTorrentForOption(previousPlaybackOption);
  }
  
  activePlaybackOption = option;
  lastObservedTime = 0;

  // Case A: Just switching audio tracks using pre-loaded metadata
  if (settings.keepTrackControls) {
    selectedAudioTrack = Number(settings.audioTrack ?? selectedAudioTrack ?? 0);
    showLoadingOverlay('Cargando pista de audio...', 'Preparando stream con nuevo idioma.', false);
    
    const prevDuration = customDuration;
    resetVideoElement();
    if (prevDuration > 0) {
      setOverrideDuration(prevDuration);
    }
    currentStartTime = currentTime > 0 ? currentTime : currentStartTime;
    
    player.source = {
      type: 'video',
      title: option.title,
      sources: [
        {
          src: streamUrlForOption(option, selectedAudioTrack, currentStartTime),
          type: playbackMimeForOption(option)
        }
      ],
      tracks: cachedCompiledTracks.map((track) => ({
        ...track,
        src: subtitleUrlForPlayback(track.src, currentStartTime)
      }))
    };

    if (trackSwapTimeRestorationListener) {
      els.video.removeEventListener('loadedmetadata', trackSwapTimeRestorationListener);
      trackSwapTimeRestorationListener = null;
    }

    // Defer setupPlyrAudioMenu to allow Plyr DOM reconstruction to finish
    setTimeout(() => {
      setupPlyrAudioMenu(player, cachedAudioTracks, selectedAudioTrack, (trackIdx) => {
        selectedAudioTrack = trackIdx;
        els.audioSelect.value = String(trackIdx);
        els.audioStatus.textContent = `Cambiando a pista de audio ${trackIdx}...`;
        playOption(option, card, { keepTrackControls: true, audioTrack: trackIdx });
      });
    }, 200);

    player.play().catch(() => {
      hideLoadingOverlay();
      els.modalStatus.textContent = 'Fuente lista. Pulsa play para iniciar la reproducción.';
    });
    return;
  }

  // Case B: Fresh video load - load video stream immediately, fetch tracks and subtitles in background
  resetVideoElement();
  resetTrackControls();
  selectedAudioTrack = 0;
  currentStartTime = 0;
  cachedCompiledTracks = [];
  cachedAudioTracks = [];
  
  showLoadingOverlay('Conectando a los peers...', 'Iniciando reproducción...', true);
  els.modalStatus.textContent = 'Iniciando stream de video y analizando pistas en segundo plano...';

  const fetchTracksWithRetry = async (attempts = 3) => {
    try {
      const response = await fetch(`/api/stream/tracks/${option.infoHash}?${new URLSearchParams({ fileIdx: String(option.fileIdx ?? 0) })}`);
      if (!response.ok) throw new Error('Failed to fetch tracks');
      const data = await response.json();
      if ((!data.audio || data.audio.length === 0) && attempts > 1) {
        if (activePlaybackOption !== option) return { audio: [], subtitles: [], duration: 0 };
        await new Promise(resolve => setTimeout(resolve, 4000));
        return fetchTracksWithRetry(attempts - 1);
      }
      return data;
    } catch {
      if (attempts > 1) {
        if (activePlaybackOption !== option) return { audio: [], subtitles: [], duration: 0 };
        await new Promise(resolve => setTimeout(resolve, 4000));
        return fetchTracksWithRetry(attempts - 1);
      }
      return { audio: [], subtitles: [], duration: 0 };
    }
  };

  const tracksPromise = fetchTracksWithRetry(3);

  const initialTracksData = isLikelyHdrOption(option)
    ? await Promise.race([
        tracksPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 8000))
      ])
    : null;

  if (initialTracksData?.duration > 0) {
    setOverrideDuration(initialTracksData.duration);
  } else {
    let fallbackDuration = 1320;
    if (activeMovie && activeMovie.mediaType === 'movie') {
      fallbackDuration = 6000;
    }
    setOverrideDuration(fallbackDuration);
  }

  // 1. Set player source with default audio track (0)
  player.source = {
    type: 'video',
    title: option.title,
    sources: [
      {
        src: streamUrlForOption(option, 0),
        type: playbackMimeForOption(option)
      }
    ]
  };

  // Start stats polling
  pollTorrentStats(option);

  // Play immediately
  player.play().catch(() => {
    hideLoadingOverlay();
    els.modalStatus.textContent = 'Fuente lista. Pulsa play en el reproductor para iniciar.';
  });

  // 2. Fetch tracks and subtitles in parallel in the background
  const subsPromise = activeMovie
    ? fetch(`/api/subtitles/batch?${new URLSearchParams({
        id: activeMovie.imdbId,
        langs: 'lat,spa,eng',
        infoHash: option.infoHash,
        fileIdx: String(option.fileIdx ?? 0),
        filename: option.title,
        type: activeMovie.mediaType === 'series' ? 'series' : 'movie',
        ...(activeMovie.season ? { season: String(activeMovie.season) } : {}),
        ...(activeMovie.episode ? { episode: String(activeMovie.episode) } : {})
      })}`)
        .then((r) => r.ok ? r.json() : { subtitles: [] })
        .catch(() => ({ subtitles: [] }))
    : Promise.resolve({ subtitles: [] });

  Promise.all([initialTracksData ? Promise.resolve(initialTracksData) : tracksPromise, subsPromise]).then(([tracksData, subsData]) => {
    // Check if user has switched to another video in the meantime
    if (activePlaybackOption !== option) return;

    // A. Process audio tracks
    const audio = tracksData.audio || [];
    cachedAudioTracks = audio;

    const duration = tracksData.duration || 0;
    if (duration > 0) {
      setOverrideDuration(duration);
    }

    // Sync legacy select elements (hidden but kept for compatibility)
    if (audio.length) {
      els.audioSelect.innerHTML = audio.map((track) => {
        const suffix = [track.language, track.codec].filter(Boolean).join(' · ');
        const label = suffix ? `${track.label} · ${suffix}` : track.label;
        return `<option value="${track.index}">${escapeHtml(label)}</option>`;
      }).join('');
      els.audioSelect.disabled = shouldUseHdrDirect(option) || audio.length < 2;
    } else {
      els.audioSelect.innerHTML = '<option value="0">Audio original</option>';
      els.audioSelect.disabled = true;
    }

    // Determine preferred audio index
    const preferredIdx = preferredAudioIndex(audio);
    
    // Update legacy select value
    els.audioSelect.value = String(preferredIdx);

    // Sync legacy select change handler
    els.audioSelect.onchange = () => {
      if (shouldUseHdrDirect(option)) return;
      selectedAudioTrack = Number(els.audioSelect.value);
      els.audioStatus.textContent = `Cambiando a ${els.audioSelect.selectedOptions[0]?.textContent || 'otra pista'}...`;
      playOption(option, card, { keepTrackControls: true, audioTrack: selectedAudioTrack });
    };

    // B. Process subtitle tracks
    const tracksList = [];

    // Embedded/Internal subtitles
    const embeddedSubs = tracksData.subtitles || [];
    embeddedSubs.filter(s => s.supported).forEach(subtitle => {
      tracksList.push({
        kind: 'captions',
        label: `Interno: ${subtitle.label || `Subtítulo ${subtitle.index + 1}`}`,
        srclang: subtitle.language || 'und',
        src: `/api/embedded-subtitles/${option.infoHash}/${subtitle.index}.vtt?fileIdx=${option.fileIdx ?? 0}`
      });
    });

    // External subtitles (OpenSubtitles)
    const externalSubs = subsData.subtitles || [];
    externalSubs.forEach(subtitle => {
      tracksList.push({
        kind: 'captions',
        label: `${subtitle.label} (${subtitle.provider})`,
        srclang: subtitle.lang,
        src: subtitle.url
      });
    });

    cachedCompiledTracks = tracksList;

    // Sync legacy subtitle select
    els.subtitleSelect.innerHTML = '<option value="off">Sin subtítulos</option>' + tracksList.map((track, idx) => {
      return `<option value="${idx}">${escapeHtml(track.label)}</option>`;
    }).join('');
    els.subtitleSelect.disabled = tracksList.length === 0;

    if (tracksList.length) {
      els.subtitleStatus.textContent = `${tracksList.length} subtítulos cargados en Plyr.`;
      
      // Inject tracks dynamically into video element
      clearTracks();
      tracksList.forEach((track, idx) => {
        const trackEl = document.createElement('track');
        trackEl.kind = track.kind;
        trackEl.label = track.label;
        trackEl.srclang = track.srclang;
        trackEl.dataset.baseSrc = track.src;
        trackEl.src = subtitleUrlForPlayback(track.src);
        if (idx === 0) trackEl.default = true;
        els.video.appendChild(trackEl);
      });

      // Auto-select first subtitle
      els.subtitleSelect.value = '0';
      setTimeout(() => setSubtitleMode(0), 100);
    } else {
      els.subtitleStatus.textContent = 'No se encontraron subtítulos externos ni internos compatibles.';
    }

    // Setup Plyr custom audio menu
    if (shouldUseHdrDirect(option)) {
      els.audioStatus.textContent = 'HDR directo activo: el navegador usa el audio original del contenedor.';
    }

    setupPlyrAudioMenu(player, shouldUseHdrDirect(option) ? [] : audio, preferredIdx, (trackIdx) => {
      selectedAudioTrack = trackIdx;
      els.audioSelect.value = String(trackIdx);
      els.audioStatus.textContent = `Cambiando a pista de audio ${trackIdx}...`;
      playOption(option, card, { keepTrackControls: true, audioTrack: trackIdx });
    });

    // C. Check if we need to auto-switch to preferred audio track
    if (preferredIdx !== 0 && !shouldUseHdrDirect(option)) {
      selectedAudioTrack = preferredIdx;
      els.audioStatus.textContent = `Cambiando automáticamente a pista de audio preferida (${preferredIdx})...`;
      playOption(option, card, { keepTrackControls: true, audioTrack: preferredIdx });
    } else {
      els.modalStatus.textContent = shouldUseHdrDirect(option)
        ? `${option.quality} HDR cargado en modo directo.`
        : `${option.quality} cargado. Remux/transcode de audio activo.`;
    }
  }).catch((error) => {
    if (activePlaybackOption !== option) return;
    els.modalStatus.textContent = `Error al inicializar el stream: ${error.message}`;
    hideLoadingOverlay();
  });
}

async function playAnimeOption(option, card) {
  const previousPlaybackOption = activePlaybackOption;
  document.querySelectorAll('[data-quality-card]').forEach((node) => {
    node.classList.remove('border-red-500', 'bg-red-500/10');
  });
  card.classList.add('border-red-500', 'bg-red-500/10');
  hideLoadingOverlay();
  destroyHls();
  if (previousPlaybackOption?.infoHash) {
    stopTorrentForOption(previousPlaybackOption);
  }
  resetVideoElement();
  resetTrackControls();
  activePlaybackOption = option;
  lastObservedTime = 0;

  if (option.sourceKind === 'hls' && window.Hls?.isSupported()) {
    hls = new Hls();
    hls.loadSource(option.url);
    hls.attachMedia(els.video);
    hls.on(Hls.Events.MANIFEST_PARSED, refreshAudioTracks);
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, refreshAudioTracks);
  } else {
    player.source = {
      type: 'video',
      title: activeMovie?.title || option.title,
      sources: [
        {
          src: option.url,
          type: option.sourceKind === 'hls' ? 'application/x-mpegURL' : 'video/mp4'
        }
      ]
    };
  }

  refreshAudioTracks();
  els.modalStatus.textContent = `${option.quality} seleccionado desde proveedor anime.`;
  player.play().catch(() => {
    hideLoadingOverlay();
    els.modalStatus.textContent = 'Fuente anime lista. Pulsa play para iniciar.';
  });
}

function renderQualities(options) {
  els.qualityList.innerHTML = '';
  els.qualityCount.textContent = `${options.length} fuentes`;

  if (!options.length) {
    els.qualityList.innerHTML = '<p class="rounded-lg border border-white/10 bg-white/5 p-4 text-sm text-zinc-400">No se encontraron fuentes con la configuración actual.</p>';
    return;
  }

  const autoplayIndex = pickAutoplayIndex(options);
  options.forEach((option, index) => {
    const compatibility = playbackCompatibility(option);
    const card = document.createElement('button');
    card.type = 'button';
    card.dataset.qualityCard = 'true';
    card.className = 'w-full min-w-0 overflow-hidden rounded-lg border border-white/10 bg-white/5 p-3 text-left transition hover:border-red-500/70 hover:bg-white/10 sm:p-4';
    card.innerHTML = `
      <div class="mb-2 flex min-w-0 flex-wrap items-center gap-1.5 sm:mb-3 sm:gap-2">
        <span class="shrink-0 rounded bg-red-600 px-2 py-1 text-xs font-black text-white">${escapeHtml(option.quality)}</span>
        <span class="shrink-0 rounded bg-white/10 px-2 py-1 text-xs font-black text-zinc-200">${escapeHtml(parseSize(option.title))}</span>
        <span class="shrink-0 rounded bg-emerald-500/15 px-2 py-1 text-xs font-black text-emerald-300">👤 ${escapeHtml(parseSeeds(option.title))}</span>
        <span class="shrink-0 rounded px-2 py-1 text-xs font-black ${compatibility.compatible === false ? 'bg-amber-500/15 text-amber-300' : 'bg-sky-500/15 text-sky-300'}">${escapeHtml(compatibility.label)}</span>
      </div>
      <strong class="line-clamp-2 block min-w-0 text-xs font-black leading-5 text-white sm:text-sm">${escapeHtml(cleanTitle(option.title))}</strong>
      <span class="mt-2 block min-w-0 truncate text-xs font-bold text-zinc-500">${escapeHtml(parseTracker(option.title))} · fileIdx ${option.fileIdx ?? 0}</span>
      <span class="mt-1 block min-w-0 truncate font-mono text-[11px] text-zinc-600">${escapeHtml(option.infoHash || option.url || option.providerId)}</span>
    `;
    card.addEventListener('click', () => option.provider === 'anime' ? playAnimeOption(option, card) : playOption(option, card));
    els.qualityList.appendChild(card);
    if (index === autoplayIndex) {
      if (option.provider === 'anime') playAnimeOption(option, card);
      else playOption(option, card);
    }
  });
}

async function openMovie(movie) {
  activeMovie = movie;
  destroyHls();
  resetTrackControls();
  els.modalTitle.textContent = movie.title;
  els.movieOverview.textContent = movie.overview || 'No hay sinopsis disponible para este título.';
  els.modalStatus.textContent = 'Buscando fuentes filtradas por español/latino y calidad reproducible...';
  els.modal.classList.remove('hidden');
  renderSkeletons();

  try {
    const params = new URLSearchParams({
      id: movie.imdbId,
      type: movie.mediaType === 'series' ? 'series' : 'movie',
      title: movie.title,
      allowUnverified: 'true'
    });
    if (movie.season) params.set('season', String(movie.season));
    if (movie.episode) params.set('episode', String(movie.episode));
    const response = await fetch(`/api/resolve?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No se pudieron resolver fuentes.');

    const options = (data.options || []).filter((option) => option.infoHash).slice(0, 30);
    els.modalStatus.textContent = `${options.length} fuentes encontradas para ${movie.title}.`;
    renderQualities(options);
  } catch (error) {
    els.qualityList.innerHTML = '';
    els.qualityCount.textContent = '0';
    els.modalStatus.textContent = error.message;
  }
}

async function openAnimeEpisode(movie, episode) {
  activeMovie = { ...movie, episode };
  destroyHls();
  resetTrackControls();
  els.modalTitle.textContent = `${movie.title} · Episodio ${episode}`;
  els.movieOverview.textContent = movie.overview || 'Anime seleccionado desde catálogo Jikan.';
  els.modalStatus.textContent = 'Buscando enlaces directos de anime...';
  els.modal.classList.remove('hidden');
  renderSkeletons();

  try {
    const params = new URLSearchParams({ title: movie.title, episode: String(episode) });
    const response = await fetch(`/api/anime/resolve?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No se pudieron resolver fuentes anime.');

    const options = (data.options || []).slice(0, 12);
    els.modalStatus.textContent = `${options.length} fuentes anime encontradas.`;
    renderQualities(options);
  } catch (error) {
    els.qualityList.innerHTML = '';
    els.qualityCount.textContent = '0';
    els.modalStatus.textContent = error.message;
  }
}

async function openSeriesSelector(series) {
  activeMovie = series;
  els.episodeEyebrow.textContent = 'Seleccionar capítulo';
  els.episodeTitle.textContent = series.title;
  els.seasonLabel.classList.remove('hidden');
  els.seasonSelect.innerHTML = '<option>Cargando...</option>';
  els.episodeGrid.innerHTML = '';
  els.episodeModal.classList.remove('hidden');

  const response = await fetch(`/api/series/${series.tmdbId}`);
  const details = await response.json();
  if (!response.ok) {
    els.episodeGrid.innerHTML = `<p class="text-sm text-zinc-400">${escapeHtml(details.error || 'No se pudo cargar la serie.')}</p>`;
    return;
  }

  els.seasonSelect.innerHTML = details.seasons.map((season) => {
    return `<option value="${season.seasonNumber}">${escapeHtml(season.name)} · ${season.episodeCount} episodios</option>`;
  }).join('');

  const loadSeason = async () => {
    const seasonNumber = Number(els.seasonSelect.value);
    els.episodeGrid.innerHTML = '<p class="text-sm text-zinc-400">Cargando episodios...</p>';
    const seasonResponse = await fetch(`/api/series/${series.tmdbId}?season=${seasonNumber}`);
    const season = await seasonResponse.json();
    if (!seasonResponse.ok) {
      els.episodeGrid.innerHTML = `<p class="text-sm text-zinc-400">${escapeHtml(season.error || 'No se pudo cargar la temporada.')}</p>`;
      return;
    }

    els.episodeGrid.innerHTML = '';
    season.episodes.forEach((episode) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rounded-lg border border-white/10 bg-white/5 p-3 text-left transition hover:border-red-500 hover:bg-white/10';
      button.innerHTML = `<strong class="block text-sm font-black">E${episode.episodeNumber}</strong><span class="mt-1 block truncate text-xs text-zinc-400">${escapeHtml(episode.title)}</span>`;
      button.addEventListener('click', () => {
        els.episodeModal.classList.add('hidden');
        openMovie({ ...series, mediaType: 'series', season: seasonNumber, episode: episode.episodeNumber });
      });
      els.episodeGrid.appendChild(button);
    });
  };

  els.seasonSelect.onchange = loadSeason;
  await loadSeason();
}

function openAnimeSelector(anime) {
  activeMovie = anime;
  els.episodeEyebrow.textContent = 'Seleccionar episodio anime';
  els.episodeTitle.textContent = anime.title;
  els.seasonLabel.classList.add('hidden');
  els.episodeGrid.innerHTML = '';
  els.episodeModal.classList.remove('hidden');

  const max = Math.min(anime.episodeCount || 24, 48);
  for (let episode = 1; episode <= max; episode += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rounded-lg border border-white/10 bg-white/5 p-3 text-left transition hover:border-red-500 hover:bg-white/10';
    button.innerHTML = `<strong class="block text-sm font-black">Episodio ${episode}</strong><span class="mt-1 block text-xs text-zinc-400">Stream directo / HLS</span>`;
    button.addEventListener('click', () => {
      els.episodeModal.classList.add('hidden');
      openAnimeEpisode(anime, episode);
    });
    els.episodeGrid.appendChild(button);
  }
}

function closeModal() {
  const previousPlaybackOption = activePlaybackOption;
  player.stop();
  destroyHls();
  hideLoadingOverlay();
  stopTorrentForOption(previousPlaybackOption);
  activePlaybackOption = null;
  currentStartTime = 0;
  clearTracks();
  resetTrackControls();
  els.modal.classList.add('hidden');
  els.qualityList.innerHTML = '';
}

async function runSearch(query) {
  if (!query) {
    els.searchSection.classList.add('hidden');
    els.catalogSections.classList.remove('hidden');
    els.clearSearch.classList.add('hidden');
    return;
  }

  els.clearSearch.classList.remove('hidden');
  els.catalogSections.classList.add('hidden');
  els.searchSection.classList.remove('hidden');
  els.searchTitle.textContent = `Buscar: ${query}`;
  els.searchStatus.textContent = 'Cargando...';
  els.searchGrid.innerHTML = '';

  try {
    const response = await fetch(`${endpoints.search}?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error de búsqueda.');

    data.forEach((movie) => els.searchGrid.appendChild(movieCard(movie, true)));
    els.searchStatus.textContent = `${data.length} resultados`;
  } catch (error) {
    els.searchStatus.textContent = error.message;
  }
}

function debounceSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(els.searchInput.value.trim()), 320);
}

function setupCarouselButtons() {
  document.querySelectorAll('[data-scroll]').forEach((button) => {
    button.addEventListener('click', () => {
      const row = document.getElementById(button.dataset.target);
      const direction = button.dataset.scroll === 'left' ? -1 : 1;
      if (!row) return;
      const amount = Math.max(360, Math.floor(row.clientWidth * 0.85));
      const next = Math.max(0, Math.min(row.scrollWidth - row.clientWidth, row.scrollLeft + (direction * amount)));
      row.scrollTo({ left: next, behavior: 'smooth' });
      window.setTimeout(() => {
        if (Math.abs(row.scrollLeft - next) > 8) row.scrollLeft = next;
      }, 240);
    });
  });
}

player.on('canplay', () => {
  if (els.loadingOverlay.classList.contains('visible')) {
    els.loadingTitle.textContent = 'Buffer listo';
    els.loadingDetail.textContent = 'Esperando reproducción estable...';
  }
  maybeHideOverlayForPlayback();
});
player.on('loadedmetadata', refreshAudioTracks);
player.on('loadeddata', maybeHideOverlayForPlayback);
player.on('progress', maybeHideOverlayForPlayback);
player.on('playing', () => {
  hideLoadingOverlay();
  refreshAudioTracks();
});
player.on('timeupdate', maybeHideOverlayForPlayback);
player.on('waiting', () => {
  if (activePlaybackOption?.infoHash) {
    showLoadingOverlay('Buffering...', 'El navegador está esperando más datos del torrent.', false);
    if (!statsTimer) pollTorrentStats(activePlaybackOption);
  }
});
player.on('stalled', () => {
  if (activePlaybackOption?.infoHash) {
    showLoadingOverlay('Conexión pausada...', 'Reintentando descarga desde peers activos.', false);
    if (!statsTimer) pollTorrentStats(activePlaybackOption);
  }
});
player.on('ready', () => {
  refreshAudioTracks();
  if (cachedAudioTracks && cachedAudioTracks.length > 1 && activePlaybackOption) {
    setupPlyrAudioMenu(player, cachedAudioTracks, selectedAudioTrack, (trackIdx) => {
      selectedAudioTrack = trackIdx;
      els.audioSelect.value = String(trackIdx);
      els.audioStatus.textContent = `Cambiando a pista de audio ${trackIdx}...`;
      playOption(activePlaybackOption, document.querySelector('[data-quality-card].border-red-500') || document.body, { keepTrackControls: true, audioTrack: trackIdx });
    });
  }
  const video = els.video;
  if (video && video.textTracks) {
    video.textTracks.addEventListener('change', () => {
      const tracks = video.textTracks;
      let showingIdx = 'off';
      for (let index = 0; index < tracks.length; index += 1) {
        if (tracks[index].mode === 'showing') {
          showingIdx = String(index);
          break;
        }
      }
      els.subtitleSelect.value = showingIdx;
    });
  }
});

async function loadCatalog() {
  await Promise.all([loadSection('trending'), loadSection('latest'), loadSection('series'), loadSection('anime')]);
}

els.searchInput.addEventListener('input', debounceSearch);
els.clearSearch.addEventListener('click', () => {
  els.searchInput.value = '';
  runSearch('');
});
els.closeModal.addEventListener('click', closeModal);
els.closeEpisodeModal.addEventListener('click', () => els.episodeModal.classList.add('hidden'));
els.modal.addEventListener('click', (event) => {
  if (event.target === els.modal) closeModal();
});
els.episodeModal.addEventListener('click', (event) => {
  if (event.target === els.episodeModal) els.episodeModal.classList.add('hidden');
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.modal.classList.contains('hidden')) closeModal();
  if (event.key === 'Escape' && !els.episodeModal.classList.contains('hidden')) els.episodeModal.classList.add('hidden');
});

setupCarouselButtons();
loadCatalog();

els.subtitleSelect.addEventListener('change', () => {
  const val = els.subtitleSelect.value;
  if (val === 'off') {
    setSubtitleMode(-1);
  } else {
    setSubtitleMode(Number(val));
  }
});

const subtitleSizeSelect = document.getElementById('subtitleSizeSelect');
if (subtitleSizeSelect) {
  const applySubtitleSize = (size) => {
    let cssVal = 'clamp(14px, 2vw, 20px)';
    if (size === 'sm') cssVal = 'clamp(12px, 1.5vw, 16px)';
    if (size === 'lg') cssVal = 'clamp(18px, 2.5vw, 26px)';
    if (size === 'xl') cssVal = 'clamp(22px, 3.2vw, 34px)';
    document.documentElement.style.setProperty('--plyr-caption-size', cssVal);
    localStorage.setItem('strimio-sub-size', size);
  };

  const savedSize = localStorage.getItem('strimio-sub-size') || 'md';
  subtitleSizeSelect.value = savedSize;
  applySubtitleSize(savedSize);

  subtitleSizeSelect.addEventListener('change', () => {
    applySubtitleSize(subtitleSizeSelect.value);
  });
}

function setupPlyrAudioMenu(playerInstance, audioTracks, currentSelectedIdx, onTrackChange) {
  const container = playerInstance.elements.container;
  if (!container) return;

  const tryInject = () => {
    const homeMenu = container.querySelector('.plyr__menu__container__inner [id$="-home"] [role="menu"]');
    const innerContainer = container.querySelector('.plyr__menu__container__inner');
    if (!homeMenu || !innerContainer) return false;

    const existingBtn = homeMenu.querySelector('[target-panel="audio"]');
    if (existingBtn) existingBtn.remove();
    const existingPanel = innerContainer.querySelector('#plyr-settings-audio-panel');
    if (existingPanel) existingPanel.remove();

    if (!audioTracks || audioTracks.length < 2) {
      return true;
    }

    const audioBtn = document.createElement('button');
    audioBtn.type = 'button';
    audioBtn.className = 'plyr__control plyr__control--forward';
    audioBtn.setAttribute('role', 'menuitem');
    audioBtn.setAttribute('aria-haspopup', 'true');
    audioBtn.setAttribute('target-panel', 'audio');
    
    const currentTrack = audioTracks.find(t => t.index === currentSelectedIdx) || audioTracks[0];
    const currentLabel = currentTrack ? (currentTrack.language || currentTrack.label || 'Original') : 'Original';
    
    audioBtn.innerHTML = `
      <span>Audio</span>
      <span class="plyr__menu__value" id="plyr-audio-value">${escapeHtml(currentLabel)}</span>
    `;
    homeMenu.appendChild(audioBtn);

    const audioPanel = document.createElement('div');
    audioPanel.id = 'plyr-settings-audio-panel';
    const speedPanel = innerContainer.querySelector('[id$="-speed"]');
    audioPanel.className = speedPanel ? speedPanel.className : 'plyr__menu__panel';
    audioPanel.setAttribute('hidden', '');

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'plyr__control plyr__control--back';
    backBtn.setAttribute('target-panel', 'home');
    
    const nativeBackBtn = speedPanel ? speedPanel.querySelector('.plyr__control--back') : null;
    if (nativeBackBtn) {
      backBtn.innerHTML = nativeBackBtn.innerHTML;
    } else {
      backBtn.innerHTML = '<span aria-hidden="true">Audio</span>';
    }
    audioPanel.appendChild(backBtn);

    const menuList = document.createElement('div');
    menuList.setAttribute('role', 'menu');
    
    audioTracks.forEach((track) => {
      const trackBtn = document.createElement('button');
      trackBtn.type = 'button';
      trackBtn.setAttribute('role', 'menuitemradio');
      trackBtn.className = 'plyr__control';
      trackBtn.setAttribute('aria-checked', track.index === currentSelectedIdx ? 'true' : 'false');
      trackBtn.value = String(track.index);
      
      const suffix = [track.language, track.codec].filter(Boolean).join(' · ');
      const label = suffix ? `${track.label} · ${suffix}` : track.label;
      trackBtn.innerHTML = `
        <span>${escapeHtml(label)}</span>
      `;
      
      trackBtn.addEventListener('click', () => {
        menuList.querySelectorAll('[role="menuitemradio"]').forEach(btn => {
          btn.setAttribute('aria-checked', 'false');
        });
        trackBtn.setAttribute('aria-checked', 'true');
        
        const valSpan = audioBtn.querySelector('#plyr-audio-value');
        if (valSpan) valSpan.textContent = track.language || track.label || 'Original';
        
        audioPanel.setAttribute('hidden', '');
        const homePanel = innerContainer.querySelector('[id$="-home"]');
        if (homePanel) homePanel.removeAttribute('hidden');
        
        onTrackChange(track.index);
      });
      
      menuList.appendChild(trackBtn);
    });
    
    audioPanel.appendChild(menuList);
    innerContainer.appendChild(audioPanel);

    audioBtn.addEventListener('click', () => {
      const homePanel = innerContainer.querySelector('[id$="-home"]');
      if (homePanel) homePanel.setAttribute('hidden', '');
      audioPanel.removeAttribute('hidden');
    });

    backBtn.addEventListener('click', () => {
      audioPanel.setAttribute('hidden', '');
      const homePanel = innerContainer.querySelector('[id$="-home"]');
      if (homePanel) homePanel.removeAttribute('hidden');
    });

    return true;
  };

  if (!tryInject()) {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts += 1;
      if (tryInject() || attempts > 12) {
        clearInterval(interval);
      }
    }, 50);
  }
}
