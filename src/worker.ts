/**
 * Cloudflare Workers entrypoint. Identical proxy logic to the Node build,
 * just wired up through the Worker `fetch` export.
 *
 * Deploy:
 *   npx wrangler deploy
 *
 * Dev:
 *   npx wrangler dev
 *
 * Config lives in wrangler.toml.
 */

import { createProxy, type ProxyConfig } from './core/proxy.js';
import type { TransformOptions } from './core/transform.js';

export interface Env {
  ANTHROPIC_UPSTREAM?: string;
  /** Optional override — if set, replaces whatever x-api-key the client sent. */
  ANTHROPIC_API_KEY?: string;
  COMPRESS?: string;
  COMPRESS_TOOLS?: string;
  COMPRESS_SCHEMAS?: string;
  MIN_COMPRESS_CHARS?: string;
  PLACEMENT?: string;
  COLS?: string;
}

const truthy = (v: string | undefined, fallback: boolean): boolean =>
  v == null ? fallback : v === '1' || v.toLowerCase() === 'true';

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const transform: TransformOptions = {
      compress: truthy(env.COMPRESS, true),
      compressTools: truthy(env.COMPRESS_TOOLS, true),
      compressSchemas: truthy(env.COMPRESS_SCHEMAS, true),
      minCompressChars: env.MIN_COMPRESS_CHARS ? Number(env.MIN_COMPRESS_CHARS) : 2000,
      placement: (env.PLACEMENT as 'system' | 'user') ?? 'system',
      cols: env.COLS ? Number(env.COLS) : 100,
    };
    const config: ProxyConfig = {
      upstream: env.ANTHROPIC_UPSTREAM ?? 'https://api.anthropic.com',
      apiKey: env.ANTHROPIC_API_KEY,
      transform,
      // Note: console.log in Workers is captured by `wrangler tail`.
      onRequest: (e) => {
        const tag = e.info?.compressed
          ? `compressed ${e.info.origChars}ch → ${e.info.imageCount}img/${e.info.imageBytes}B`
          : e.info?.reason ?? '';
        console.log(`${e.method} ${e.path} → ${e.status} (${e.durationMs}ms) ${tag}`);
      },
    };
    const handle = createProxy(config);
    return handle(req);
  },
};
