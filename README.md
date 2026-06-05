# Strimio Dev

Prototipo de streaming P2P para magnets autorizados: contenido propio, licenciado, Creative Commons o de dominio publico.

## Comandos

```bash
npm install
npm run dev
npm run build
```

WebTorrent en navegador conecta mediante WebRTC/web seeds. Para torrents BitTorrent tradicionales conviene agregar despues un backend o una app desktop.

## SourceRegistry

Strimio separa metadata de reproduccion. Puede mostrar catalogos amplios, pero solo reproduce fuentes aprobadas en `src/sourceRegistry.js`.

Providers permitidos:

- Dominio publico o archivos publicos verificables.
- Creative Commons compatible.
- Contenido propio.
- Partners o APIs oficiales.
- Fuentes aportadas por usuario con declaracion de derechos.

Providers tipo Torrentio o ani-cli deben implementarse como adaptadores que entreguen fuentes registradas y verificables, no como resolvers genericos de torrents/streams no autorizados.

## Resolver unificado

El modulo `src/unifiedContentResolver.js` combina adaptadores de Torrentio y anime anicli-compatible en una sola salida JSON.

Ejemplo:

```bash
npm run resolve:sources -- --id tt0063350 --title "Night of the Living Dead" --type movie
```

Para anime, apunta `ANICLI_API_BASE_URL` a un backend propio/autorizado con endpoints `GET /search?q=` y `GET /episode-sources?animeId=&episode=`:

```bash
ANICLI_API_BASE_URL="https://tu-api.example" npm run resolve:sources -- --title "Anime legal" --animeEpisode 1
```

Por defecto, el resolver devuelve metadata bloqueada si la fuente no pasa por la allowlist (`isAuthorizedStream` / `isAuthorizedSource`). En desarrollo puedes inspeccionar el formato con `--allowUnverified true`, pero el player de Strimio debe reproducir solo fuentes autorizadas por `SourceRegistry`.

## Streamer local experimental

El backend `server/index.ts` expone una interfaz local para resolver opciones Torrentio, autorizar hashes en sesion y servir video con HTTP Range Requests usando WebTorrent.

```bash
PORT=3100 STRIMIO_ALLOW_UNVERIFIED=true npm run dev:streamer
```

Abre:

```text
http://localhost:3100/player.html
```

Endpoints:

- `GET /api/resolve?id=tt0063350&type=movie`
- `GET /api/stream/:infoHash?fileIdx=0`
- `GET /api/subtitles?id=tt0063350&lang=spa`
- `GET /api/subtitles/batch?id=tt0063350&langs=lat,spa,eng&infoHash=...`

Subtitulos:

- OpenSubtitles: configura `OPENSUBTITLES_API_KEY` y `OPENSUBTITLES_USER_AGENT`.
- SubDL fallback: configura `SUBDL_API_KEY`.
- Los archivos descargados se convierten a WebVTT y se cachean en `subs/`.

Nota de codecs: muchos torrents `.mkv` con DTS/AC3/HEVC no se reproducen nativamente en Chrome/Safari. El endpoint entrega bytes y rangos correctamente; si el navegador no decodifica, la siguiente fase debe agregar transcodificacion con FFmpeg hacia MP4/HLS con audio AAC.
