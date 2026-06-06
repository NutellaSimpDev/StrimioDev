declare module 'webtorrent' {
  export default class WebTorrent {
    destroyed: boolean;
    constructor(options?: Record<string, unknown>);
    add(torrentId: string, options?: Record<string, unknown>): unknown;
    get(torrentId: string): unknown;
    destroy(cb?: (err?: Error) => void): void;
    on(event: string, cb: (...args: any[]) => void): this;
  }
}
