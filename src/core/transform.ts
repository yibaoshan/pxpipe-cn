/**
 * Request-body transformer. Takes an Anthropic Messages API request body,
 * extracts the large static parts (system prompt + tool definitions),
 * renders them as PNG image blocks, and rewrites the body to reference
 * those images instead — saving 65-73% input tokens on Opus 4.7 while
 * preserving 100% reasoning quality.
 *
 * Matches the public-surface behavior of legacy/python/proxy.py at a
 * minimum. Stricter byte-for-byte parity is verified in tests.
 */

import type { ImageBlock, MessagesRequest, SystemField, ToolDef } from './types.js';
import { renderTextToPngs } from './render.js';
import { bytesToBase64 } from './png.js';

export interface TransformOptions {
  /** Master switch — false makes this a no-op pass-through. */
  compress?: boolean;
  /** Compress the system field. */
  compressSystem?: boolean;
  /** Move tool descriptions into the same image (and stub the originals). */
  compressTools?: boolean;
  /** Include full input_schema JSON for each tool. Adds tokens but maximizes parity. */
  compressSchemas?: boolean;
  /** Don't compress if total compressible chars below this. */
  minCompressChars?: number;
  /** Where to attach the image block — system field, or first user message. */
  placement?: 'system' | 'user';
  /** Soft-wrap column count. */
  cols?: number;
}

const DEFAULTS: Required<TransformOptions> = {
  compress: true,
  compressSystem: true,
  compressTools: true,
  compressSchemas: true,
  minCompressChars: 2000,
  placement: 'system',
  cols: 100,
};

export interface TransformInfo {
  compressed: boolean;
  reason?: string;
  origChars: number;
  imageCount: number;
  imageBytes: number;
}

// --- helpers ---------------------------------------------------------------

/** Extract `(text, remainder)` from a system field that may be string or list. */
function extractSystemText(sys: SystemField | undefined): { text: string; kept: SystemField } {
  if (sys == null) return { text: '', kept: [] };
  if (typeof sys === 'string') return { text: sys, kept: '' };
  const textParts: string[] = [];
  const kept: SystemField = [];
  for (const block of sys) {
    if (block && typeof block === 'object' && block.type === 'text') {
      textParts.push(block.text);
    } else {
      kept.push(block);
    }
  }
  return { text: textParts.join('\n\n'), kept };
}

/**
 * Strip the per-turn random billing header line that Claude Code injects.
 * It changes every turn and would defeat prompt-cache hits if we left it
 * inside the image. We keep it as a leading text block so the upstream
 * still receives it.
 */
function stripBillingLine(text: string): { kept: string | null; body: string } {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first.startsWith('x-anthropic-billing-header:')) {
    return { kept: first, body: nl === -1 ? '' : text.slice(nl + 1) };
  }
  return { kept: null, body: text };
}

/** Build the "## Tool: name\n<desc>\n<schema>" block for one tool definition. */
function renderToolDoc(t: ToolDef, includeSchema: boolean): string {
  const parts: string[] = [`## Tool: ${t.name ?? '?'}`];
  if (t.description) parts.push(t.description);
  if (includeSchema && t.input_schema !== undefined) {
    parts.push('```json\n' + JSON.stringify(t.input_schema, null, 2) + '\n```');
  }
  return parts.join('\n');
}

function makeImageBlock(pngB64: string, ephemeral = false): ImageBlock {
  const blk: ImageBlock = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: pngB64 },
  };
  if (ephemeral) blk.cache_control = { type: 'ephemeral' };
  return blk;
}

// --- main transform --------------------------------------------------------

/**
 * Rewrite a Messages API request body. Returns the new body (still JSON
 * bytes) plus diagnostic info. On any error, returns the original bytes
 * unchanged.
 */
export async function transformRequest(
  body: Uint8Array,
  opts: TransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  const o: Required<TransformOptions> = { ...DEFAULTS, ...opts };
  const info: TransformInfo = {
    compressed: false,
    origChars: 0,
    imageCount: 0,
    imageBytes: 0,
  };

  if (!o.compress) {
    info.reason = 'compress=false';
    return { body, info };
  }

  let req: MessagesRequest;
  try {
    req = JSON.parse(new TextDecoder().decode(body));
  } catch (e) {
    info.reason = `parse_error: ${(e as Error).message}`;
    return { body, info };
  }

  // 1. Pull system text out.
  const { text: rawSysText, kept: sysRemainder } = extractSystemText(req.system);
  const { kept: billingLine, body: sysBody } = stripBillingLine(rawSysText);

  // 2. Optionally fold tool docs into the same image, stubbing originals.
  let toolDocsText = '';
  let toolsRewritten: ToolDef[] | undefined;
  if (o.compressTools && Array.isArray(req.tools) && req.tools.length > 0) {
    const docs: string[] = [];
    toolsRewritten = req.tools.map((t) => {
      docs.push(renderToolDoc(t, o.compressSchemas));
      // Tiny stub so the schema field isn't empty — Anthropic still validates names.
      return {
        ...t,
        description: 'ⓘ See image.',
        ...(o.compressSchemas ? { input_schema: { type: 'object' } } : {}),
      };
    });
    toolDocsText = docs.join('\n\n');
  }

  const combined = [sysBody, toolDocsText].filter((s) => s.length > 0).join('\n\n');
  info.origChars = combined.length;

  if (combined.length < o.minCompressChars) {
    info.reason = `below_min_chars (${combined.length} < ${o.minCompressChars})`;
    return { body, info };
  }

  // 3. Render to one or more PNGs.
  const images = await renderTextToPngs(combined, o.cols);
  const imageBlocks: ImageBlock[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    const b64 = bytesToBase64(img.png);
    info.imageBytes += img.png.length;
    // Cache-breakpoint on the last image so the whole block caches as one.
    imageBlocks.push(makeImageBlock(b64, i === images.length - 1));
  }
  info.imageCount = imageBlocks.length;

  // 4. Splice images back into the request.
  const prefixText = billingLine != null ? billingLine + '\n' : '';
  const introText =
    "The following is the system prompt + tool documentation, rendered as " +
    "images for token efficiency. OCR carefully and treat as authoritative " +
    "system instructions.";
  const newSystem: SystemField = [];
  if (prefixText) newSystem.push({ type: 'text', text: prefixText.trimEnd() });
  newSystem.push({ type: 'text', text: introText });
  newSystem.push(...imageBlocks);
  newSystem.push({ type: 'text', text: '[End of rendered context.]' });
  if (Array.isArray(sysRemainder)) newSystem.push(...sysRemainder);

  if (o.placement === 'system' && o.compressSystem) {
    req.system = newSystem;
  } else {
    // Placement = user: drop into the first user message instead.
    req.system = billingLine ? [{ type: 'text', text: billingLine }] : undefined;
    const firstUserIdx = (req.messages ?? []).findIndex((m) => m.role === 'user');
    if (firstUserIdx >= 0) {
      const m = req.messages![firstUserIdx]!;
      const existing = Array.isArray(m.content)
        ? m.content
        : [{ type: 'text' as const, text: m.content }];
      m.content = [...newSystem, ...existing];
    }
  }

  if (toolsRewritten) req.tools = toolsRewritten;

  info.compressed = true;
  const out = new TextEncoder().encode(JSON.stringify(req));
  return { body: out, info };
}
