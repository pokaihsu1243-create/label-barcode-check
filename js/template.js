// 模板疊合比對：把候選字用標籤的字形（Arial／Calibri）渲染出來，直接跟印刷字比形狀。
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

// 下面三個門檻都是實測決定的（兩份 Arial 實稿＋兩份 Calibri 實稿共 568 字，另加 Courier 合成稿）。
//
// 為什麼需要它們：Arial 和 Calibri 的數字長得很像。拿「相近但不對」的字形去讀，
// 會「很有把握地讀錯」——Calibri 模板讀 Arial 印的 …450… 會穩穩讀成 …460…（5 認成 6），
// 每個字的相似度都在 0.80 以上；Arial 模板讀 Calibri 的 1 會讀成 I。
// 單看「多像」擋不住（正確字形最低 0.846、錯字形可到 0.814，空隙太薄），
// 真正可靠的是兩種字形互相比：正確字形在每一列都比另一種更像，差距最少 0.019。
export const TPL_MIN_SIM = 0.70;   // 單字：最像的模板都不到這個程度 → 這個字標 ?（正確字形最低 0.846）
export const TPL_MIN_FIT = 0.83;   // 整列：平均相似度不到 → 印的不是已知字形（正確最低 0.879，Courier 0.75）
export const TPL_FONT_GAP = 0.01;  // 兩種字形像到分不出來 → 不採用（正確最少差 0.019，Courier 只差 0.002）

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
  const margins = [], best = [];
  for (const g of glyphs) {
    const sims = [];
    for (const ch of TPL_CAND) {
      const t = tpl(ch, g.h, font);
      if (t) sims.push([dot(g.v, t), ch]);
    }
    if (sims.length < 2) { out += '?'; margins.push(0); best.push(0); continue; }
    sims.sort((a, b) => b[0] - a[0]);
    const margin = sims[0][0] - sims[1][0];
    // 兩個條件都要過：跟次像的字拉得開（分得出是哪個字），而且最像的那個本身夠像（不是殘缺、污損的字）
    out += (margin >= TPL_MIN_MARGIN && sims[0][0] >= TPL_MIN_SIM) ? sims[0][1] : '?';
    margins.push(margin);
    best.push(sims[0][0]);
    simSum += sims[0][0];
  }
  return { text: out, margins, best, font, fit: glyphs.length ? simSum / glyphs.length : 0 };
}

/** 這台電腦缺哪些標籤字形。缺任何一種，字形之間的比較就不成立（見 templateRead）。 */
export function missingFonts() {
  return TPL_FONTS.filter(f => !fontAvailable(f));
}

/**
 * 不靠 OCR 讀出每個字。回傳 { text, margins, best, font, fit, why }；分不出來的位置給 '?'。
 * 這一軌不適用時，why 說明原因（text 為空字串或全部 '?'）。
 *
 * 每種字形各讀一次，取「整列平均最像程度（fit）」最高的那種。選字形只看形狀像不像，
 * **不看讀出來的字對不對得上條碼**——這一軌要保持獨立。三種情況不採用：
 *   ① 這台電腦缺了其中一種字形——比較不成立，「相近但不對」的字形會很有把握地讀錯
 *   ② 最像的字形也不夠像——印的不是已知字形
 *   ③ 兩種字形像到分不出來——不知道該信哪一種
 */
export function templateRead(glyphs, fonts = TPL_FONTS) {
  const empty = why => ({ text: '', margins: [], best: [], font: null, fit: 0, why });
  if (!glyphs || !glyphs.length) return empty(null);
  const missing = fonts.filter(f => !fontAvailable(f));
  if (missing.length && fonts === TPL_FONTS)
    return empty(`這台電腦缺少 ${missing.join('、')} 字型，無法比較印字是哪一種字形`);

  const ranked = fonts.filter(fontAvailable).map(f => readWith(glyphs, f)).sort((a, b) => b.fit - a.fit);
  if (!ranked.length) return empty('這台電腦沒有可用的標籤字形');
  const [top, second] = ranked;
  const blank = why => ({ ...top, text: '?'.repeat(glyphs.length), why });
  if (top.fit < TPL_MIN_FIT)
    return blank(`印字的字形不是 ${fonts.join('／')}（最像的是 ${top.font}，平均相似度 ${top.fit.toFixed(3)}，`
                 + `未達 ${TPL_MIN_FIT}）`);
  if (second && top.fit - second.fit < TPL_FONT_GAP)
    return blank(`分不出印字是 ${top.font} 還是 ${second.font}（平均相似度 ${top.fit.toFixed(3)} 對 `
                 + `${second.fit.toFixed(3)}，差距未達 ${TPL_FONT_GAP}）`);
  return { ...top, why: null };
}
