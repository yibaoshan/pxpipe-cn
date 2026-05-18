/**
 * Text → PNG renderer. Uses the build-time atlas (src/core/atlas.ts) and
 * blits glyphs into a single grayscale framebuffer, then PNG-encodes.
 *
 * Behavior matches the Python proxy's "minimum rows / max packed width"
 * approach: wrap at a fixed column count and pack as many lines per image
 * as fit within `MAX_HEIGHT_PX`. Anthropic's vision encoder works best with
 * images ≤ 1568×1568 px.
 */

import {
  ATLAS_CELL_W,
  ATLAS_CELL_H,
  ATLAS_FIRST,
  ATLAS_LAST,
  ATLAS_PIXELS,
} from './atlas.js';
import { encodeGrayPng } from './png.js';

const MAX_HEIGHT_PX = 1568;
const DEFAULT_COLS = 100;
const PAD_X = 4;
const PAD_Y = 4;

export interface RenderedImage {
  /** Raw PNG bytes. */
  png: Uint8Array;
  /** Pixel width. */
  width: number;
  /** Pixel height. */
  height: number;
  /** How many input characters were rendered into this image. */
  charsRendered: number;
}

/** Soft-wrap a single logical line at `cols`, preserving explicit newlines. */
function wrapLines(text: string, cols: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (raw.length === 0) {
      out.push('');
      continue;
    }
    for (let i = 0; i < raw.length; i += cols) {
      out.push(raw.slice(i, i + cols));
    }
  }
  return out;
}

/**
 * Blit a single glyph onto the framebuffer with simple max() blending
 * (so we keep the darkest coverage if glyphs overlap on antialiased edges).
 */
function blitGlyph(fb: Uint8Array, fbW: number, x: number, y: number, code: number): void {
  if (code < ATLAS_FIRST || code > ATLAS_LAST) return; // skip unrenderable
  const glyphOff = (code - ATLAS_FIRST) * ATLAS_CELL_W * ATLAS_CELL_H;
  for (let gy = 0; gy < ATLAS_CELL_H; gy++) {
    const dstRow = (y + gy) * fbW + x;
    const srcRow = glyphOff + gy * ATLAS_CELL_W;
    for (let gx = 0; gx < ATLAS_CELL_W; gx++) {
      const v = ATLAS_PIXELS[srcRow + gx]!;
      if (v > fb[dstRow + gx]!) fb[dstRow + gx] = v;
    }
  }
}

/** Render up to `maxChars` of `text` to a single PNG, returning leftover text + image. */
export async function renderChunkToPng(
  text: string,
  cols: number = DEFAULT_COLS,
): Promise<RenderedImage> {
  const lines = wrapLines(text, cols);

  // Compute how many lines we can fit vertically.
  const maxLines = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / ATLAS_CELL_H));
  const fitLines = lines.slice(0, maxLines);

  const charsRendered = fitLines.reduce((n, l) => n + l.length + 1, -1); // -1: no trailing \n

  const width = 2 * PAD_X + cols * ATLAS_CELL_W;
  const height = 2 * PAD_Y + fitLines.length * ATLAS_CELL_H;

  // Black canvas (matches atlas: text is white-on-black, but the model OCRs
  // both polarities — we invert below to white-on-black for crispness).
  const fb = new Uint8Array(width * height); // zero-initialized = black

  for (let row = 0; row < fitLines.length; row++) {
    const line = fitLines[row]!;
    const baseY = PAD_Y + row * ATLAS_CELL_H;
    for (let col = 0; col < line.length; col++) {
      const baseX = PAD_X + col * ATLAS_CELL_W;
      blitGlyph(fb, width, baseX, baseY, line.charCodeAt(col));
    }
  }

  // Invert: atlas stores white-on-black coverage, but black-on-white renders
  // cleaner and matches what the Python proxy emits.
  for (let i = 0; i < fb.length; i++) fb[i] = 255 - fb[i]!;

  const png = await encodeGrayPng(fb, width, height);
  return { png, width, height, charsRendered };
}

/** Split `text` into N PNGs, each ≤ MAX_HEIGHT_PX tall. */
export async function renderTextToPngs(
  text: string,
  cols: number = DEFAULT_COLS,
): Promise<RenderedImage[]> {
  const lines = wrapLines(text, cols);
  const linesPerImg = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / ATLAS_CELL_H));

  const images: RenderedImage[] = [];
  for (let i = 0; i < lines.length; i += linesPerImg) {
    const chunk = lines.slice(i, i + linesPerImg).join('\n');
    images.push(await renderChunkToPng(chunk, cols));
  }
  return images;
}
