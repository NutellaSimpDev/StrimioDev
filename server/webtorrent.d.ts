declare module 'webtorrent' {
  export default class WebTorrent {
    constructor(options?: Record<string, unknown>);
    add(torrentId: string, options?: Record<string, unknown>): unknown;
    get(torrentId: string): unknown;
  }
}
