/**
 * Node entrypoint — `node:http` server + minimal CLI flag parsing.
 *
 * Wraps the runtime-agnostic `createProxy` from src/core/proxy.ts. The
 * heavy lifting (transform, render, PNG) is identical to the Worker
 * version; only the request/response plumbing differs.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createProxy, type ProxyConfig } from './core/proxy.js';
import type { TransformOptions } from './core/transform.js';

interface CliOpts {
  port: number;
  upstream: string;
  compress: boolean;
  compressTools: boolean;
  compressSchemas: boolean;
  minCompressChars: number;
  placement: 'system' | 'user';
  cols: number;
}

function envFlag(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null) return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

function parseCli(argv: string[]): CliOpts {
  const o: CliOpts = {
    port: Number(process.env.PORT ?? 47821),
    upstream: process.env.ANTHROPIC_UPSTREAM ?? 'https://api.anthropic.com',
    compress: envFlag('COMPRESS', true),
    compressTools: envFlag('COMPRESS_TOOLS', true),
    compressSchemas: envFlag('COMPRESS_SCHEMAS', true),
    minCompressChars: Number(process.env.MIN_COMPRESS_CHARS ?? 2000),
    placement: (process.env.PLACEMENT as 'system' | 'user') ?? 'system',
    cols: Number(process.env.COLS ?? 100),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eat = () => argv[++i]!;
    switch (a) {
      case '-p':
      case '--port':           o.port = Number(eat()); break;
      case '--upstream':       o.upstream = eat(); break;
      case '--no-compress':    o.compress = false; break;
      case '--no-tools':       o.compressTools = false; break;
      case '--no-schemas':     o.compressSchemas = false; break;
      case '--min-chars':      o.minCompressChars = Number(eat()); break;
      case '--placement':      o.placement = eat() as 'system' | 'user'; break;
      case '--cols':           o.cols = Number(eat()); break;
      case '-h':
      case '--help':           printHelp(); process.exit(0);
      case '--version':        printVersion(); process.exit(0);
      default:
        if (a.startsWith('--')) {
          console.error(`[pixelpipe] unknown option: ${a}`);
          process.exit(2);
        }
    }
  }
  return o;
}

function printHelp(): void {
  console.log(`pixelpipe — token-saving proxy for Claude Code

Usage:
  pixelpipe [options]

Options:
  -p, --port <N>          listen port (default 47821)
      --upstream <URL>    Anthropic API base (default https://api.anthropic.com)
      --no-compress       disable all compression (pure passthrough)
      --no-tools          don't fold tool docs into the image
      --no-schemas        don't include input_schema JSON in the image
      --min-chars <N>     skip compression below this many chars (default 2000)
      --placement <where> 'system' or 'user' (default system)
      --cols <N>          soft-wrap column count (default 100)
  -h, --help              show this help
      --version           show version

Environment:
  Same as flags via PORT, ANTHROPIC_UPSTREAM, COMPRESS, COMPRESS_TOOLS,
  COMPRESS_SCHEMAS, MIN_COMPRESS_CHARS, PLACEMENT, COLS.

Use with Claude Code:
  ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude --exclude-dynamic-system-prompt-sections
`);
}

function printVersion(): void {
  // Filled in at bundle time by esbuild.define; falls back here.
  console.log(process.env.npm_package_version ?? '0.2.0');
}

// ---- node:http <-> Web Request/Response bridge ---------------------------

function toWebRequest(req: IncomingMessage): Request {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http';
  const host = req.headers.host ?? 'localhost';
  const url = `${proto}://${host}${req.url ?? '/'}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else headers.append(k, v);
  }

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  // Buffer the body — proxy needs to read /v1/messages bodies fully anyway,
  // and Node's IncomingMessage → ReadableStream conversion has duplex quirks.
  let body: BodyInit | undefined;
  if (hasBody) {
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        req.on('data', (chunk) => controller.enqueue(chunk));
        req.on('end', () => controller.close());
        req.on('error', (e) => controller.error(e));
      },
    });
  }

  return new Request(url, {
    method,
    headers,
    body,
    // @ts-expect-error — duplex is required for streamed request bodies in Node 18+
    duplex: hasBody ? 'half' : undefined,
  });
}

async function writeWebResponse(res: Response, out: ServerResponse): Promise<void> {
  out.statusCode = res.status;
  res.headers.forEach((v, k) => out.setHeader(k, v));
  if (!res.body) {
    out.end();
    return;
  }
  const reader = res.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out.write(value);
  }
  out.end();
}

// ---- main ----------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  const transform: TransformOptions = {
    compress: opts.compress,
    compressTools: opts.compressTools,
    compressSchemas: opts.compressSchemas,
    minCompressChars: opts.minCompressChars,
    placement: opts.placement,
    cols: opts.cols,
  };
  const config: ProxyConfig = {
    upstream: opts.upstream,
    transform,
    onRequest: (e) => {
      const tag = e.info?.compressed
        ? `compressed ${e.info.origChars}ch → ${e.info.imageCount}img/${e.info.imageBytes}B`
        : e.info?.reason ?? '';
      console.log(`[${new Date().toISOString()}] ${e.method} ${e.path} → ${e.status} (${e.durationMs}ms) ${tag}`);
    },
  };
  const handle = createProxy(config);

  const server = createServer((req, res) => {
    Promise.resolve()
      .then(async () => {
        const webReq = toWebRequest(req);
        const webRes = await handle(webReq);
        await writeWebResponse(webRes, res);
      })
      .catch((err) => {
        console.error('[pixelpipe] handler error:', err);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
  });

  server.listen(opts.port, () => {
    console.log(`[pixelpipe] listening on http://127.0.0.1:${opts.port} → ${opts.upstream}`);
    console.log(`[pixelpipe] config: compress=${opts.compress} tools=${opts.compressTools} schemas=${opts.compressSchemas} min=${opts.minCompressChars} placement=${opts.placement} cols=${opts.cols}`);
  });

  const shutdown = (sig: string) => {
    console.log(`[pixelpipe] ${sig} — shutting down`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[pixelpipe] fatal:', err);
  process.exit(1);
});
