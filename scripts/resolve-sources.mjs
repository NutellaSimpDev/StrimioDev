#!/usr/bin/env node
import { resolveUnifiedPlayback } from '../src/unifiedContentResolver.js';

function readArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = argv[index + 1]?.startsWith('--') ? true : argv[index + 1] ?? true;
  }
  return args;
}

const args = readArgs(process.argv.slice(2));

async function main() {
  const result = await resolveUnifiedPlayback({
    id: args.id,
    title: args.title,
    type: args.type || 'movie',
    season: args.season ? Number(args.season) : undefined,
    episode: args.episode ? Number(args.episode) : undefined,
    animeTitle: args.animeTitle || args.title,
    animeEpisode: args.animeEpisode ? Number(args.animeEpisode) : undefined,
    torrentio: {
      baseUrl: args.torrentioBaseUrl || process.env.TORRENTIO_BASE_URL,
      configPath: args.torrentioConfigPath || process.env.TORRENTIO_CONFIG_PATH,
      isAuthorizedStream: () => args.allowUnverified === 'true'
    },
    anicli: {
      apiBaseUrl: args.anicliApi || process.env.ANICLI_API_BASE_URL,
      isAuthorizedSource: () => args.allowUnverified === 'true'
    }
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
