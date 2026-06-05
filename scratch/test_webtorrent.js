import WebTorrent from 'webtorrent';

const client = new WebTorrent();
const infoHash = '08ada5a7a6183aae1e09d831df6748d566095a10'; // Sintel infoHash

console.log(`Adding torrent: ${infoHash}`);
const torrent = client.add(`magnet:?xt=urn:btih:${infoHash}`);

torrent.on('infoHash', () => {
  console.log('infoHash resolved:', torrent.infoHash);
});

torrent.on('metadata', () => {
  console.log('metadata resolved. Files:', torrent.files.map(f => f.name));
});

torrent.on('ready', () => {
  console.log('Torrent ready.');
});

torrent.on('wire', (wire) => {
  console.log(`Connected to peer: ${wire.remoteAddress}:${wire.remotePort}`);
});

const timer = setInterval(() => {
  console.log(`Progress: ${torrent.progress * 100}%, Peers: ${torrent.numPeers}, Speed: ${torrent.downloadSpeed} B/s`);
}, 2000);

setTimeout(() => {
  clearInterval(timer);
  client.destroy(() => {
    console.log('Client destroyed.');
  });
}, 15000);
