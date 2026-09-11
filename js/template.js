// 模板疊合比對：把「條碼說的那個字」用 Arial 渲染出來，直接跟印刷字比形狀。
// 這條完全不經 OCR，也不拿條碼當提示——它不問「這是什麼字」，
// 而是對 36 個候選字各算一次相似度，看最像的那個是誰。
// 所以它與 OCR 互相獨立，才有資格當第二條證據。
import { GLYPH_N, areaResize, dot, newCanvas, ctx2d } from './imgproc.js';

export const TPL_CAND = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const TPL_MIN_MARGIN = 0.02;      // 最佳與次佳太接近就當作分不出來

const cache = new Map();

function build(ch, hh) {
  const size = Math.max(8, Math.floor(hh / 0.72));
  const S = Math.floor(hh * 2.2) + 8;
  const cv = newCanvas(S, S);
  const c = ctx2d(cv);
  c.fillStyle = '#000';
  c.fillRect(0, 0, S, S);
  c.font = size + 'px Arial';
  c.fillStyle = '#fff';
  c.textBaseline = 'alphabetic';
  const m = c.measureText(ch);
  const off = Math.floor(hh * 0.4);
  c.fillText(ch, off + (m.actualBoundingBoxLeft || 0), off + (m.actualBoundingBoxAscent || size));

  const img = c.getImageData(0, 0, S, S).data;
  const a = new Float32Array(S * S);
  let x0 = S, y0 = S, x1 = -1, y1 = -1;
  for (let i = 0; i < S * S; i++) {
    const v = img[i * 4];
    a[i] = v;
    if (v > 96) {                        // 與桌面版同一個取墨門檻
      const x = i % S, y = (i / S) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const gw = x1 - x0 + 1, gh = y1 - y0 + 1;
  const side = Math.max(gw, gh);
  const pad = new Float32Array(side * side);
  const ox = (side - gw) >> 1, oy = (side - gh) >> 1;
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++)
      pad[(oy + j) * side + ox + i] = a[(y0 + j) * S + x0 + i];
  const v = areaResize(pad, side, side, GLYPH_N, GLYPH_N);
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] = v[i] >= 128 ? 255 : 0;        // 模板本身取回純二值，避免字級不同時邊緣灰階影響比對
    n += v[i] * v[i];
  }
  n = Math.sqrt(n);
  if (n < 1e-6) return null;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function tpl(ch, h) {
  const hh = Math.round(h / 4) * 4;      // 字高分桶，同一桶共用模板
  const key = ch + '@' + hh;
  if (!cache.has(key)) cache.set(key, build(ch, hh));
  return cache.get(key);
}

/** 不靠 OCR 讀出每個字。回傳 { text, margins }；分不出來的位置給 '?'。 */
export function templateRead(glyphs) {
  if (!glyphs || !glyphs.length) return { text: '', margins: [] };
  let out = '';
  const margins = [];
  for (const g of glyphs) {
    const sims = [];
    for (const ch of TPL_CAND) {
      const t = tpl(ch, g.h);
      if (t) sims.push([dot(g.v, t), ch]);
    }
    if (sims.length < 2) { out += '?'; margins.push(0); continue; }
    sims.sort((a, b) => b[0] - a[0]);
    const margin = sims[0][0] - sims[1][0];
    out += margin >= TPL_MIN_MARGIN ? sims[0][1] : '?';
    margins.push(margin);
  }
  return { text: out, margins };
}
