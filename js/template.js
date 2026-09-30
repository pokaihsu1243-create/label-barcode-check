// 模板疊合比對：把「條碼說的那個字」用 Arial 渲染出來，直接跟印刷字比形狀。
// 這條完全不經 OCR，也不拿條碼當提示——它不問「這是什麼字」，
// 而是對 36 個候選字各算一次相似度，看最像的那個是誰。
// 所以它與 OCR 互相獨立，才有資格當第二條證據。
import { GLYPH_N, areaResize, dot, newCanvas, ctx2d } from './imgproc.js';

export const TPL_CAND = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const TPL_MIN_MARGIN = 0.02;      // 最佳與次佳太接近就當作分不出來

// 標籤稿實際用到的字形。Code 128 那批是 Arial；Data Matrix 那批（字排在圖案右側、分三行）是 Calibri。
// 每一列用哪個字形，是看「哪個字形最能解釋印出來的形狀」決定的——完全不看條碼內容，
// 否則這一軌就不再獨立於條碼了。
export const TPL_FONTS = ['Arial', 'Calibri'];

const cache = new Map();
const availability = new Map();

/**
 * 這台電腦有沒有這個字型。沒有的話瀏覽器會默默換成別的字型來畫，
 * 做出來的模板就是錯的——所以一定要先確認，沒有就不用它（該列會因此轉成待確認，而不是讀錯）。
 */
export function fontAvailable(font) {
  if (availability.has(font)) return availability.get(font);
  // 判斷法：字型存在時，「指定字型＋任一種後備字型」量出來的寬度都會是指定字型的寬度，
  // 至少會跟某一種後備字型不同；不存在時則每一種都退回後備字型、寬度完全相同。
  // 注意是「任一種不同就算存在」，不是「每一種都要不同」——Windows 上瀏覽器預設的
  // sans-serif 本身就是 Arial，拿 Arial 跟 sans-serif 比一定一樣寬，
  // 用「每一種都要不同」會把明明裝著的 Arial 判成沒有（實測踩過）。
  const c = ctx2d(newCanvas(8, 8));
  const probe = 'mmmmmmmmmmlli0123456789WQ';
  let ok = false;
  for (const base of ['monospace', 'serif', 'sans-serif']) {
    c.font = '72px ' + base;
    const w0 = c.measureText(probe).width;
    c.font = `72px "${font}", ${base}`;
    if (Math.abs(c.measureText(probe).width - w0) >= 0.5) { ok = true; break; }
  }
  availability.set(font, ok);
  return ok;
}

function build(ch, hh, font) {
  const size = Math.max(8, Math.floor(hh / 0.72));
  const S = Math.floor(hh * 2.2) + 8;
  const cv = newCanvas(S, S);
  const c = ctx2d(cv);
  c.fillStyle = '#000';
  c.fillRect(0, 0, S, S);
  c.font = `${size}px "${font}"`;
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

function tpl(ch, h, font) {
  const hh = Math.round(h / 4) * 4;      // 字高分桶，同一桶共用模板
  const key = ch + '@' + hh + '@' + font;
  if (!cache.has(key)) cache.set(key, build(ch, hh, font));
  return cache.get(key);
}

function readWith(glyphs, font) {
  let out = '', simSum = 0;
  const margins = [];
  for (const g of glyphs) {
    const sims = [];
    for (const ch of TPL_CAND) {
      const t = tpl(ch, g.h, font);
      if (t) sims.push([dot(g.v, t), ch]);
    }
    if (sims.length < 2) { out += '?'; margins.push(0); continue; }
    sims.sort((a, b) => b[0] - a[0]);
    const margin = sims[0][0] - sims[1][0];
    out += margin >= TPL_MIN_MARGIN ? sims[0][1] : '?';
    margins.push(margin);
    simSum += sims[0][0];
  }
  return { text: out, margins, font, fit: glyphs.length ? simSum / glyphs.length : 0 };
}

/**
 * 不靠 OCR 讀出每個字。回傳 { text, margins, font, fit }；分不出來的位置給 '?'。
 *
 * 每個可用字形各讀一次，取「整列平均最像程度（fit）」最高的那個字形的結果。
 * 選字形只看形狀像不像，**不看讀出來的字對不對得上條碼**——這一軌要保持獨立。
 * 所有候選字形都不在這台電腦上時，回傳空結果，該列轉待確認。
 */
export function templateRead(glyphs, fonts = TPL_FONTS) {
  if (!glyphs || !glyphs.length) return { text: '', margins: [], font: null, fit: 0 };
  const usable = fonts.filter(fontAvailable);
  if (!usable.length) return { text: '', margins: [], font: null, fit: 0 };
  let best = null;
  for (const f of usable) {
    const r = readWith(glyphs, f);
    if (!best || r.fit > best.fit) best = r;
  }
  return best;
}
