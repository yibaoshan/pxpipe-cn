/**
 * The pixelpipe proxy as a single Web-standard fetch handler.
 *
 * Both `src/node.ts` and `src/worker.ts` adapt this to their respective
 * runtimes (node:http server vs CF Worker `fetch` export). The handler
 * itself only uses `Request`, `Response`, `URL`, and global `fetch` — all
 * of which exist identically in Node 18+ and Workers.
 */

import { transformRequest, type TransformOptions, type TransformInfo } from './transform.js';

export interface ProxyConfig {
  /** Anthropic API base, no trailing slash. Defaults to api.anthropic.com. */
  upstream?: string;
  /** Override or supply an API key. If unset, we forward whatever the client sent. */
  apiKey?: string;
  /** Per-request transform options. */
  transform?: TransformOptions;
  /** Called after every request — useful for logging / metrics in the host. */
  onRequest?: (event: ProxyEvent) => void | Promise<void>;
}

export interface ProxyEvent {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  info?: TransformInfo;
  error?: string;
}

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

/** Headers we strip on the way out — they're hop-by-hop or proxy-injected. */
const STRIP_REQ_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-length', // we recompute
  'expect',
  'accept-encoding', // let upstream choose
]);

const STRIP_RES_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding', // we don't re-encode
  'content-length',   // body may differ after streaming
]);

function filterHeaders(src: Headers, strip: Set<string>): Headers {
  const out = new Headers();
  src.forEach((v, k) => {
    if (!strip.has(k.toLowerCase())) out.append(k, v);
  });
  return out;
}

/** Build the proxy fetch handler bound to a config. */
export function createProxy(config: ProxyConfig = {}) {
  const upstream = (config.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, '');

  return async function handle(req: Request): Promise<Response> {
    const t0 = Date.now();
    const url = new URL(req.url);
    const path = url.pathname + url.search;

    const fire = (status: number, info?: TransformInfo, error?: string): void => {
      void config.onRequest?.({
        method: req.method,
        path: url.pathname,
        status,
        durationMs: Date.now() - t0,
        info,
        error,
      });
    };

    // Only intercept /v1/messages POSTs. Everything else passes through.
    const isMessages = req.method === 'POST' && url.pathname === '/v1/messages';

    let bodyOut: BodyInit | null = null;
    let info: TransformInfo | undefined;

    if (isMessages) {
      const bodyIn = new Uint8Array(await req.arrayBuffer());
      try {
        const r = await transformRequest(bodyIn, config.transform);
        // Cast: TS narrows Uint8Array<ArrayBufferLike> away from BodyInit, but
        // it's a valid body and we never use SharedArrayBuffer.
        bodyOut = r.body as unknown as BodyInit;
        info = r.info;
      } catch (e) {
        fire(502, undefined, `transform_error: ${(e as Error).message}`);
        return new Response(JSON.stringify({ error: 'pixelpipe transform failed' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
    } else {
      // Pass body through unchanged.
      bodyOut = req.body;
    }

    const outHeaders = filterHeaders(req.headers, STRIP_REQ_HEADERS);
    if (config.apiKey) outHeaders.set('x-api-key', config.apiKey);

    const upstreamUrl = upstream + path;
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: outHeaders,
        body: bodyOut,
        // duplex is required by spec when sending a stream as body
        ...(bodyOut instanceof ReadableStream ? { duplex: 'half' } : {}),
      } as RequestInit);
    } catch (e) {
      fire(502, info, `upstream_error: ${(e as Error).message}`);
      return new Response(JSON.stringify({ error: 'pixelpipe upstream unreachable' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }

    fire(upstreamRes.status, info);

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: filterHeaders(upstreamRes.headers, STRIP_RES_HEADERS),
    });
  };
}
