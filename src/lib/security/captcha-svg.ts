import "server-only";
import { randomInt } from "node:crypto";

type Stroke = readonly (readonly [number, number])[];

/**
 * Geometric vector stroke paths on a 0..12 x 0..20 glyph grid.
 * Rendered purely as randomized SVG <path> elements (no <text> nodes).
 */
const GLYPHS: Record<string, readonly Stroke[]> = {
  "0": [[[6, 1], [10, 3], [11, 10], [10, 17], [6, 19], [2, 17], [1, 10], [2, 3], [6, 1]]],
  "1": [[[3, 5], [6, 1], [6, 19]], [[3, 19], [9, 19]]],
  "2": [[[1, 5], [3, 2], [7, 1], [10, 3], [10, 7], [6, 12], [1, 19], [11, 19]]],
  "3": [[[1, 3], [5, 1], [9, 2], [10, 6], [6, 9], [10, 13], [9, 18], [5, 19], [1, 17]]],
  "4": [[[8, 19], [8, 1], [1, 13], [11, 13]]],
  "5": [[[10, 1], [2, 1], [1, 9], [6, 8], [10, 10], [11, 15], [8, 19], [3, 19], [1, 17]]],
  "6": [[[9, 2], [5, 1], [2, 5], [1, 12], [2, 18], [6, 19], [10, 17], [10, 12], [7, 10], [2, 11]]],
  "7": [[[1, 2], [11, 2], [6, 11], [4, 19]]],
  "8": [
    [[6, 9], [2, 7], [2, 3], [6, 1], [10, 3], [10, 7], [6, 9]],
    [[6, 9], [1, 12], [1, 17], [6, 19], [11, 17], [11, 12], [6, 9]],
  ],
  "9": [[[10, 9], [6, 10], [2, 8], [2, 3], [6, 1], [10, 3], [11, 10], [9, 17], [5, 19], [2, 18]]],
  "+": [[[6, 5], [6, 15]], [[1, 10], [11, 10]]],
  "-": [[[1, 10], [11, 10]]],
  "=": [[[1, 7], [11, 7]], [[1, 13], [11, 13]]],
  "?": [[[2, 5], [4, 2], [8, 1], [10, 4], [9, 8], [6, 11], [6, 14]], [[6, 18], [6.2, 18.6]]],
};

const INK_COLORS = ["#0b5d3b", "#153e5c", "#1f2937", "#0d4f4f", "#3a2d6b", "#14532d"] as const;
const NOISE_COLORS = ["#86c5a7", "#9bbcd4", "#b5c9c3", "#a5b4fc", "#cbd5e1"] as const;

const EN_NUMBERS: Record<number, string> = {
  1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine",
  10: "ten", 11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen", 15: "fifteen", 16: "sixteen",
  17: "seventeen", 18: "eighteen",
};

const KM_NUMBERS: Record<number, string> = {
  1: "មួយ", 2: "ពីរ", 3: "បី", 4: "បួន", 5: "ប្រាំ", 6: "ប្រាំមួយ", 7: "ប្រាំពីរ", 8: "ប្រាំបី", 9: "ប្រាំបួន",
  10: "ដប់", 11: "ដប់មួយ", 12: "ដប់ពីរ", 13: "ដប់បី", 14: "ដប់បួន", 15: "ដប់ប្រាំ", 16: "ដប់ប្រាំមួយ",
  17: "ដប់ប្រាំពីរ", 18: "ដប់ប្រាំបី",
};

function jitter(v: number, range = 0.7): string {
  const delta = ((randomInt(0, 1001) / 1000) * 2 - 1) * range;
  return (v + delta).toFixed(1);
}

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(0, arr.length)]!;
}

/** Normalize ASCII, Khmer (០-៩), and full-width (０-９) numerals and trim whitespace. */
export function normalizeCaptchaAnswer(raw: string): string {
  return raw
    .trim()
    .replace(/[\u17e0-\u17e9]/g, (ch) => String(ch.charCodeAt(0) - 0x17e0))
    .replace(/[\uff10-\uff19]/g, (ch) => String(ch.charCodeAt(0) - 0xff10))
    .replace(/\s+/g, "");
}

function generateMathEquation(): { a: number; b: number; op: "+" | "-"; answer: string } {
  const isAdd = randomInt(0, 10) < 6;
  if (isAdd) {
    const a = randomInt(2, 13);
    const b = randomInt(2, 10);
    return { a, b, op: "+", answer: String(a + b) };
  }
  const b = randomInt(1, 8);
  const a = randomInt(b + 2, 19);
  return { a, b, op: "-", answer: String(a - b) };
}

function renderGlyphGroup(ch: string, x: number, y: number): string {
  const strokes = GLYPHS[ch];
  if (!strokes) return "";
  const angle = randomInt(-13, 14);
  const scaleX = (0.95 + randomInt(0, 22) / 100).toFixed(2);
  const scaleY = (0.95 + randomInt(0, 22) / 100).toFixed(2);
  const color = pick(INK_COLORS);
  const strokeWidth = (2.3 + randomInt(0, 8) / 10).toFixed(1);

  const paths = strokes
    .map((pts) => {
      const d = pts
        .map(([px, py], idx) => `${idx === 0 ? "M" : "L"}${jitter(px * 1.45, 0.75)} ${jitter(py * 1.45, 0.75)}`)
        .join(" ");
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("");

  return `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${angle} 9 14) scale(${scaleX},${scaleY})">${paths}</g>`;
}

/**
 * Generate a randomized vector-path SVG math CAPTCHA encoded as a data URI.
 * Zero <text> elements or plaintext digits appear in the SVG output.
 */
export function generateVisualCaptcha(): { imageDataUri: string; answer: string } {
  const { a, b, op, answer } = generateMathEquation();
  const tokens = `${a}${op}${b}=?`.split("");

  const width = 220;
  const height = 64;

  // Subtle background interference curves
  const curves: string[] = [];
  const curveCount = randomInt(4, 7);
  for (let i = 0; i < curveCount; i++) {
    const x1 = randomInt(0, 40);
    const y1 = randomInt(4, height - 4);
    const cx1 = randomInt(50, 110);
    const cy1 = randomInt(0, height);
    const cx2 = randomInt(110, 170);
    const cy2 = randomInt(0, height);
    const x2 = randomInt(width - 40, width);
    const y2 = randomInt(4, height - 4);
    const sw = (1 + randomInt(0, 12) / 10).toFixed(1);
    curves.push(
      `<path d="M${x1} ${y1} C${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}" fill="none" stroke="${pick(NOISE_COLORS)}" stroke-width="${sw}" opacity="0.55"/>`,
    );
  }

  // Random decoy dots
  const dots: string[] = [];
  const dotCount = randomInt(18, 26);
  for (let i = 0; i < dotCount; i++) {
    const cx = randomInt(6, width - 6);
    const cy = randomInt(6, height - 6);
    const r = (0.9 + randomInt(0, 14) / 10).toFixed(1);
    dots.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${pick(NOISE_COLORS)}" opacity="0.6"/>`);
  }

  // Render expression glyphs centered horizontally
  const totalWidth = tokens.length * 24 + (tokens.length - 1) * 4;
  let cursorX = Math.max(14, Math.floor((width - totalWidth) / 2));
  const glyphGroups: string[] = [];
  for (const ch of tokens) {
    const y = 16 + randomInt(-4, 5);
    glyphGroups.push(renderGlyphGroup(ch, cursorX, y));
    cursorX += ch === "+" || ch === "-" || ch === "=" ? 27 : 25 + randomInt(-2, 4);
  }

  // One foreground thin distraction curve across glyphs
  const fgCurve = `<path d="M${randomInt(10, 35)} ${randomInt(18, 46)} Q${randomInt(90, 130)} ${randomInt(6, 58)} ${randomInt(185, 210)} ${randomInt(18, 46)}" fill="none" stroke="${pick(NOISE_COLORS)}" stroke-width="1.3" opacity="0.45"/>`;

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    `<rect width="${width}" height="${height}" rx="12" fill="#f3faf6"/>`,
    ...dots,
    ...curves,
    ...glyphGroups,
    fgCurve,
    `</svg>`,
  ].join("");

  const imageDataUri = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  return { imageDataUri, answer };
}

/**
 * Generate an accessible localized word-arithmetic prompt for screen-reader or low-vision users.
 * Always paired with PoW + single-use signed token + rate limiting.
 */
export function generateAccessibleCaptcha(locale: "km" | "en"): { prompt: string; answer: string } {
  const { a, b, op, answer } = generateMathEquation();
  if (locale === "km") {
    const wordA = KM_NUMBERS[a] ?? String(a);
    const wordB = KM_NUMBERS[b] ?? String(b);
    const opWord = op === "+" ? "បូក" : "ដក";
    return { prompt: `តើ ${wordA} ${opWord} ${wordB} ស្មើប៉ុន្មាន?`, answer };
  }
  const wordA = EN_NUMBERS[a] ?? String(a);
  const wordB = EN_NUMBERS[b] ?? String(b);
  const opWord = op === "+" ? "plus" : "minus";
  return { prompt: `What is ${wordA} ${opWord} ${wordB}?`, answer };
}
