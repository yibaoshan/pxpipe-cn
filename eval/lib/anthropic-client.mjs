/**
 * eval/lib/anthropic-client.mjs
 *
 * Model-call layer for the eval harness.
 *
 * Runs entirely on the local Claude Max subscription by shelling out to the
 * interactive `claude` TUI via the cci.py shim (NOT headless `claude -p`). NO
 * Anthropic API key is used or required.
 *
 * Why the CLI and not the HTTP API:
 *   The operator runs on a Claude Max subscription, which does not expose a
 *   raw API key. The `claude` binary authenticates via the subscription's
 *   stored OAuth credentials (~/.claude), so `claude -p` calls bill against
 *   the subscription, not a metered API key.
 *
 * Proxy bypass:
 *   The interactive `claude` shell alias points ANTHROPIC_BASE_URL at the
 *   local pxpipe proxy. The eval MUST NOT go through pxpipe — that would
 *   transform/compress the very images we are trying to measure. So every call
 *   here (a) invokes the real binary at ~/.claude/local/claude rather than the
 *   alias, and (b) strips ANTHROPIC_BASE_URL from the child environment. The
 *   CLI then talks straight to api.anthropic.com with the subscription token.
 *
 * Contract — UNCHANGED from the previous HTTP client so the eval scripts need
 * no edits:
 *   createClient({ model?, dryRun? }) -> { messages, dryRun, model }
 *   messages({ system?, messages, max_tokens? })
 *     -> { content: [{ type:'text', text }], usage: {...} }
 *
 * In --dry-run mode every call is a no-op returning a plausible fake response.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Real claude binary — NOT the shell alias, which injects the proxy base URL.
const CLAUDE_BIN = join(homedir(), '.claude', 'local', 'claude');

// Interactive shim: drives the real TUI (Max auth) instead of headless `claude -p`.
const CCI_PY = join(dirname(fileURLToPath(import.meta.url)), 'cci.py');
const PYTHON = process.env.CCI_PYTHON || 'python3';

// ---------------------------------------------------------------------------
// Direct-HTTP mode (relay auth)
//
// The CLI path above assumes Max-subscription OAuth and that ANTHROPIC_BASE_URL
// points at the LOCAL pxpipe proxy (so it must be stripped). Neither holds when
// the operator authenticates through a remote relay: there is no OAuth in the
// keychain, and ANTHROPIC_AUTH_TOKEN is only valid AGAINST the relay — sending
// it to api.anthropic.com yields 401 "Invalid bearer token". In that setup the
// relay speaks the plain Messages API (verified incl. image blocks), so we call
// it directly and skip the TUI entirely. Auto-detected: a non-local
// ANTHROPIC_BASE_URL plus a token selects HTTP mode; force with
// PXPIPE_EVAL_TRANSPORT=http|cli.
// ---------------------------------------------------------------------------

const RELAY_BASE = (process.env.ANTHROPIC_BASE_URL ?? '').replace(/\/+$/, '');
const RELAY_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? '';
const RELAY_IS_LOCAL = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(RELAY_BASE);
const TRANSPORT = process.env.PXPIPE_EVAL_TRANSPORT
  ?? (RELAY_BASE && RELAY_TOKEN && !RELAY_IS_LOCAL ? 'http' : 'cli');

/** Resolve a harness model string to the relay's real model name (the relay
 *  publishes its names via the ANTHROPIC_DEFAULT_*_MODEL env contract). */
function relayModelName(model) {
  const m = (model ?? '').toLowerCase();
  if (m.includes('opus'))  return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL  || model;
  if (m.includes('haiku')) return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || model;
  if (m.includes('sonnet')) return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || model;
  return model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
}

/** POST the Anthropic-format body to the relay verbatim (images stay inline). */
async function callRelayHttp(body, model) {
  const res = await fetch(`${RELAY_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${RELAY_TOKEN}`,
      'x-api-key': RELAY_TOKEN,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: body.max_tokens ?? 2048,
      ...(body.system ? { system: body.system } : {}),
      messages: body.messages,
    }),
  });
  if (!res.ok) {
    throw new Error(`relay ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const j = await res.json();
  if (j.type === 'error') throw new Error(`relay error: ${JSON.stringify(j.error).slice(0, 300)}`);
  // The relay force-enables thinking on some models, so content[0] may be a
  // thinking block. Eval scripts read content[0].text — normalize to a single
  // joined text block so they never see thinking.
  const text = (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { ...j, content: [{ type: 'text', text }] };
}

/**
 * Map any model string to a CLI alias so the CLI always resolves the latest
 * snapshot (the harness defaults to a pinned name that may lag the CLI build).
 * @param {string} [model]
 */
function modelAlias(model) {
  const m = (model ?? '').toLowerCase();
  if (m.includes('opus'))  return 'opus';
  if (m.includes('haiku')) return 'haiku';
  return 'sonnet';
}

/**
 * Create a client.
 *
 * @param {{ model?: string, dryRun?: boolean }} opts
 * @returns {{ messages: Function, dryRun: boolean, model: string }}
 */
export function createClient(opts = {}) {
  const dryRun = !!opts.dryRun;
  const model  = TRANSPORT === 'http' ? relayModelName(opts.model) : modelAlias(opts.model);

  /**
   * Call the model.
   * @param {{ system?: string, messages: object[], max_tokens?: number }} body
   * @returns {Promise<{ content: Array<{type:string,text:string}>, usage: object }>}
   */
  async function messages(body) {
    if (dryRun) return fakeDryRunResponse(body);
    if (TRANSPORT === 'http') return callRelayHttp(body, model);
    return callClaudeCli(body, model);
  }

  return { messages, dryRun, model };
}

// ---------------------------------------------------------------------------
// Real call — `claude -p` headless on the Max subscription
// ---------------------------------------------------------------------------

/**
 * Translate an Anthropic-format request body into a single headless `claude`
 * invocation. Image blocks are written to temp PNG files and referenced by
 * path; the CLI reads them with its Read tool.
 *
 * @param {{ system?: string, messages: object[] }} body
 * @param {string} model  CLI model alias
 */
async function callClaudeCli(body, model) {
  const tmpFiles = [];
  const contentParts = [];
  let imageCount = 0;

  for (const msg of body.messages ?? []) {
    const content = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text', text: String(msg.content ?? '') }];
    for (const blk of content) {
      if (blk.type === 'image') {
        const p = join(tmpdir(), `eval-img-${randomUUID()}.png`);
        writeFileSync(p, Buffer.from(blk.source.data, 'base64'));
        tmpFiles.push(p);
        imageCount++;
        contentParts.push(`[IMAGE #${imageCount} — file: ${p}]`);
      } else if (blk.type === 'text') {
        contentParts.push(blk.text);
      }
    }
  }

  // Assemble the prompt: system instructions first, then (if any) a directive
  // to Read the referenced image files, then the ordered content.
  const parts = [];
  if (body.system) parts.push(body.system.trim(), '');
  if (imageCount > 0) {
    parts.push(
      `There ${imageCount === 1 ? 'is 1 image' : `are ${imageCount} images`} ` +
      `referenced below by absolute file path. Use the Read tool to view ` +
      `${imageCount === 1 ? 'it' : 'each one, in order,'} before answering. ` +
      `Do not use any tool other than Read.`,
      '',
    );
  }
  parts.push(...contentParts);
  const prompt = parts.join('\n');

  // Child env: strip the proxy override so the CLI hits the real API directly
  // with the subscription OAuth token. Tall buffer so long transcriptions are
  // not truncated by the visible screen height.
  const env = { ...process.env, CCI_ROWS: process.env.CCI_ROWS || '1500' };
  delete env.ANTHROPIC_BASE_URL;

  const args = [
    CCI_PY,
    '--model', model,
    '--output-format', 'json',
  ];
  if (imageCount > 0) args.push('--allowedTools', 'Read');

  let stdout = '', stderr = '';
  try {
    await new Promise((resolveP, rejectP) => {
      const child = spawn(PYTHON, args, { env });
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('error', rejectP);
      child.on('close', code => {
        if (code === 0) resolveP();
        else rejectP(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 400)}`));
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  } finally {
    for (const f of tmpFiles) {
      try { if (existsSync(f)) unlinkSync(f); } catch { /* leftover temp is harmless */ }
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`claude CLI returned non-JSON output: ${stdout.slice(0, 400)}`);
  }
  if (parsed.is_error || parsed.subtype !== 'success') {
    throw new Error(`claude CLI error: ${parsed.result ?? parsed.subtype ?? 'unknown'}`);
  }

  return {
    id:      parsed.session_id ?? 'cli',
    type:    'message',
    role:    'assistant',
    model,
    content: [{ type: 'text', text: parsed.result ?? '' }],
    // Interactive mode has no clean server `usage` block. input_tokens is the
    // /context estimate; total_cost_usd is the /cost server total. output_tokens
    // is not separately reported by the interactive panels.
    usage: {
      input_tokens:  parsed.context_tokens ?? 0,
      output_tokens: 0,
    },
    total_cost_usd: parsed.total_cost_usd ?? null,
  };
}

// ---------------------------------------------------------------------------
// Dry-run fake responses
// ---------------------------------------------------------------------------

/**
 * Produce a plausible fake response for dry-run mode.
 * For OCR tasks: returns a slightly-degraded version of any text it can detect
 * in the request (to produce non-trivial diff scores).
 * For judge tasks: returns a structured JSON verdict.
 */
function fakeDryRunResponse(body) {
  const isJudge = body.system?.includes('judge') || body.system?.includes('score');

  let extractedText = '';
  for (const msg of body.messages ?? []) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') extractedText += block.text + '\n';
      }
    } else if (typeof msg.content === 'string') {
      extractedText += msg.content + '\n';
    }
  }

  let responseText;
  if (isJudge) {
    responseText = JSON.stringify({
      score:      0.85,
      reasoning:  '[DRY RUN] Reflow answer is substantially equivalent to baseline. Minor wording differences observed.',
      verdict:    'pass',
    });
  } else {
    responseText = simulateOcrNoise(extractedText.slice(0, 1000)) ||
      '[DRY RUN] Transcription not available — no text content detected in request.';
  }

  return {
    id:      'dry_run_fake_id',
    type:    'message',
    role:    'assistant',
    model:   'dry-run',
    content: [{ type: 'text', text: responseText }],
    usage:   { input_tokens: 0, output_tokens: 0 },
    _dryRun: true,
  };
}

/**
 * Simulate OCR noise by randomly dropping or substituting ~3% of characters.
 * Produces a non-trivial edit distance so dry-run diff scoring has something
 * to work with.
 */
function simulateOcrNoise(text, errorRate = 0.03) {
  if (!text) return text;
  const chars = [...text]; // Unicode-safe
  const result = [];
  for (const ch of chars) {
    const r = Math.random();
    if (r < errorRate / 3) {
      // drop
    } else if (r < errorRate * 2 / 3) {
      result.push(ch, ch); // double
    } else if (r < errorRate) {
      result.push(String.fromCharCode(ch.charCodeAt(0) + 1)); // substitute
    } else {
      result.push(ch);
    }
  }
  return result.join('');
}
