/**
 * Usage-probe baseline fallback (relay upstreams without count_tokens).
 *
 * Some relays 404 /v1/messages/count_tokens, so baseline_tokens was
 * unmeasurable there (baseline_probe_status stuck at 'failed'). The fallback
 * replays the PRE-COMPRESSION body at max_tokens=1 against /v1/messages on a
 * configured sample of requests and reads the billed usage block instead.
 * These tests pin: body shaping (fields, cache_control stripping), the
 * fire-only-after-count_tokens-fails ordering, sampling gate, and telemetry
 * (baseline_probe_method).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import {
  buildUsageProbeBody,
  buildCacheablePrefixUsageProbeBody,
} from '../src/core/measurement.js';
import { toTrackEvent } from '../src/core/tracker.js';

// ---------------------------------------------------------------------------
// Body shaping
// ---------------------------------------------------------------------------

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b: Uint8Array | null) =>
  b === null ? null : (JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>);

describe('buildUsageProbeBody', () => {
  it('keeps probe fields, forces max_tokens=1 + stream=false, drops the rest', () => {
    const out = dec(
      buildUsageProbeBody(
        enc({
          model: 'claude-fable-5',
          messages: [{ role: 'user', content: 'hi' }],
          system: 'sys',
          tools: [{ name: 't', input_schema: { type: 'object' } }],
          max_tokens: 4096,
          stream: true,
          temperature: 0.7,
          metadata: { user_id: 'u' },
          thinking: { type: 'enabled', budget_tokens: 2048 },
        }),
      ),
    )!;
    expect(out.max_tokens).toBe(1);
    expect(out.stream).toBe(false);
    expect(out.system).toBe('sys');
    expect(out.tools).toHaveLength(1);
    // thinking dropped: budget_tokens must be < max_tokens, impossible at 1.
    expect(out.thinking).toBeUndefined();
    expect(out.temperature).toBeUndefined();
    expect(out.metadata).toBeUndefined();
  });

  it('strips every cache_control marker so the probe cannot create cache entries', () => {
    const out = dec(
      buildUsageProbeBody(
        enc({
          model: 'claude-fable-5',
          system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
            },
          ],
        }),
      ),
    )!;
    expect(JSON.stringify(out)).not.toContain('cache_control');
  });

  it('returns null on non-Messages bodies', () => {
    expect(buildUsageProbeBody(enc({ foo: 1 }))).toBeNull();
    expect(buildUsageProbeBody(new TextEncoder().encode('not json'))).toBeNull();
  });

  it('cacheable-prefix variant: null without markers, truncated probe body with', () => {
    const noMarkers = enc({
      model: 'claude-fable-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(buildCacheablePrefixUsageProbeBody(noMarkers)).toBeNull();

    const withMarker = enc({
      model: 'claude-fable-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'cached part', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'cold tail' },
          ],
        },
      ],
    });
    const out = dec(buildCacheablePrefixUsageProbeBody(withMarker))!;
    expect(out.max_tokens).toBe(1);
    expect(JSON.stringify(out)).toContain('cached part');
    expect(JSON.stringify(out)).not.toContain('cold tail');
    expect(JSON.stringify(out)).not.toContain('cache_control');
  });
});

// ---------------------------------------------------------------------------
// Proxy wiring
// ---------------------------------------------------------------------------

function mockUpstream(handler: (req: Request) => Promise<Response> | Response) {
  const real = globalThis.fetch;
  globalThis.fetch = ((req: Request | string | URL, init?: RequestInit) => {
    const r = req instanceof Request ? req : new Request(String(req), init);
    return Promise.resolve(handler(r));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** Compressible request: big system slab so transform actually engages. */
const REQ_BODY = JSON.stringify({
  model: 'claude-fable-5',
  max_tokens: 100,
  system: 'System instruction. '.repeat(900),
  messages: [{ role: 'user', content: 'hi' }],
});

const MAIN_RESPONSE = () =>
  new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 120, output_tokens: 7 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

async function runProxy(opts: {
  sampleRate?: number;
  countTokensStatus: number;
  probeUsage?: Record<string, unknown>;
}) {
  const seen: { url: string; body: Record<string, unknown> | null }[] = [];
  const restore = mockUpstream(async (req) => {
    const body = await req.text().then(
      (t) => (t ? (JSON.parse(t) as Record<string, unknown>) : null),
      () => null,
    );
    seen.push({ url: req.url, body });
    if (req.url.endsWith('/count_tokens')) {
      return new Response(
        opts.countTokensStatus === 200 ? JSON.stringify({ input_tokens: 9000 }) : 'not found',
        { status: opts.countTokensStatus },
      );
    }
    // The probe replay is distinguishable from the main forward by max_tokens=1.
    if (body?.max_tokens === 1) {
      return new Response(
        JSON.stringify({
          id: 'msg_probe',
          usage: opts.probeUsage ?? { input_tokens: 5000 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return MAIN_RESPONSE();
  });

  let captured: ProxyEvent | undefined;
  const proxy = createProxy({
    upstream: 'http://upstream.test',
    transform: { charsPerToken: 1, minCompressChars: 1 },
    usageProbeSampleRate: opts.sampleRate,
    onRequest: (e) => {
      captured = e;
    },
  });
  const res = await proxy(
    new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: REQ_BODY,
    }),
  );
  await res.text();
  // finalize() awaits the fallback probe; poll briefly instead of one fixed tick.
  for (let i = 0; i < 50 && !captured; i++) await new Promise((r) => setTimeout(r, 10));
  restore();
  return { captured, seen };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('proxy usage-probe fallback', () => {
  it('fires the max_tokens=1 replay when count_tokens 404s and the sample hits', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // always inside the sample
    const { captured, seen } = await runProxy({ sampleRate: 0.05, countTokensStatus: 404 });
    expect(captured?.info?.baselineTokens).toBe(5000);
    expect(captured?.info?.baselineProbeStatus).toBe('ok');
    expect(captured?.info?.baselineProbeMethod).toBe('usage_sample');
    const probe = seen.find((s) => s.body?.max_tokens === 1);
    expect(probe).toBeDefined();
    expect(probe!.url).toBe('http://upstream.test/v1/messages');
    // Event row carries the method for offline scoring.
    const ev = toTrackEvent(captured!);
    expect(ev.baseline_probe_method).toBe('usage_sample');
    expect(ev.baseline_tokens).toBe(5000);
  });

  it('sums input + cache_create + cache_read from the probe usage block', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { captured } = await runProxy({
      sampleRate: 1,
      countTokensStatus: 404,
      probeUsage: {
        input_tokens: 100,
        cache_creation_input_tokens: 4000,
        cache_read_input_tokens: 800,
      },
    });
    expect(captured?.info?.baselineTokens).toBe(4900);
  });

  it('does NOT fire when count_tokens succeeds (free path wins)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { captured, seen } = await runProxy({ sampleRate: 1, countTokensStatus: 200 });
    expect(captured?.info?.baselineTokens).toBe(9000);
    expect(captured?.info?.baselineProbeMethod).toBe('count_tokens');
    expect(seen.some((s) => s.body?.max_tokens === 1)).toBe(false);
  });

  it('does NOT fire outside the sample — status stays failed, method absent', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // above any sane rate
    const { captured, seen } = await runProxy({ sampleRate: 0.05, countTokensStatus: 404 });
    expect(captured?.info?.baselineTokens).toBeUndefined();
    expect(captured?.info?.baselineProbeStatus).toBe('failed');
    expect(captured?.info?.baselineProbeMethod).toBeUndefined();
    expect(seen.some((s) => s.body?.max_tokens === 1)).toBe(false);
    const ev = toTrackEvent(captured!);
    expect(ev.baseline_probe_method).toBeUndefined();
  });

  it('rate 0 / unset keeps upstream behavior byte-identical (no probe, failed status)', async () => {
    const { captured, seen } = await runProxy({ countTokensStatus: 404 });
    expect(captured?.info?.baselineProbeStatus).toBe('failed');
    expect(seen.some((s) => s.body?.max_tokens === 1)).toBe(false);
  });
});
