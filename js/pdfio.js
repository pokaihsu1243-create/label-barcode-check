// PDF／影像輸入、幾何定位、轉正。幾何算式與桌面版 text_geom() 完全相同。
import { newCanvas, ctx2d } from './imgproc.js';

// 所有相依都放在 vendor/ 自己託管，不連 CDN：
// 工廠的電腦可能在防火牆後面、或裝了擋外部網域的擴充套件，連得到 CDN 不能當作前提。
// 而且這是「靜態 import」而不是頂層 await——頂層 await 會讓整個模組圖等在網路上，
// 一旦取不到，import 這個模組的程式（包括介面的事件綁定）就完全不會執行。
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';

export const pdfjsLib = pdfjs;
pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

export async function openPdf(buf) {
  return pdfjsLib.getDocument({ data: buf }).promise;
}

export async function renderPage(page, dpi) {
  const vp = page.getViewport({ scale: dpi / 72 });
  const cv = newCanvas(Math.floor(vp.width), Math.floor(vp.height));
  const c = ctx2d(cv);
  c.fillStyle = '#fff';
  c.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: c, viewport: vp }).promise;
  return cv;
}

/**
 * 只把某一塊區域用高解析度重新渲染出來。
 * 整頁 800dpi 的畫布是 A4 六千多萬畫素、佔 240MB，瀏覽器扛不住；
 * 只渲染要用的那一塊，既省記憶體，拿到的也是**真的重新渲染**（資訊量確實增加），
 * 不是把 400dpi 的圖內插放大——後者沒有新資訊，不能拿來當補字的依據。
 */
export async function renderRegion(page, dpi, rect, baseDpi) {
  const k = dpi / baseDpi;
  const x0 = Math.trunc(rect[0] * k), y0 = Math.trunc(rect[1] * k);
  const x1 = Math.trunc(rect[2] * k), y1 = Math.trunc(rect[3] * k);
  const cv = newCanvas(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  const c = ctx2d(cv);
  c.fillStyle = '#fff';
  c.fillRect(0, 0, cv.width, cv.height);
  await page.render({
    canvasContext: c,
    viewport: page.getViewport({ scale: dpi / 72 }),
    transform: [1, 0, 0, 1, -x0, -y0]
  }).promise;
  return cv;
}

export function cropCanvas(src, rect) {
  const x0 = Math.trunc(rect[0]), y0 = Math.trunc(rect[1]);
  const x1 = Math.trunc(rect[2]), y1 = Math.trunc(rect[3]);
  const cv = newCanvas(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  ctx2d(cv).drawImage(src, x0, y0, cv.width, cv.height, 0, 0, cv.width, cv.height);
  return cv;
}

/** 轉正。與桌面版 PIL 的 img.rotate(ang, expand=True) 等效（canvas 的旋轉方向相反）。 */
export function upright(src, ang) {
  const a = ((Math.round(ang) % 360) + 360) % 360;
  if (!a) return src;
  const swap = (a === 90 || a === 270);
  const cv = newCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const c = ctx2d(cv);
  c.translate(cv.width / 2, cv.height / 2);
  c.rotate(-a * Math.PI / 180);
  c.drawImage(src, -src.width / 2, -src.height / 2);
  return cv;
}

/**
 * 用條碼四角算出「它自己下方」那塊文字區，以及要轉正需旋轉幾度。
 *
 * 注意：zxing 的 top/bottom 是**頁面座標**的上下，只有 topLeft→topRight
 * 這條邊代表條碼真正的閱讀方向。垂直方向必須由閱讀方向轉 90° 求得，
 * 不能直接拿 bottomLeft−topLeft——180° 的條碼會算到反邊，抓到隔壁標籤的字。
 */
export function textGeom(pos, W, H) {
  const p = [pos.topLeft, pos.topRight, pos.bottomRight, pos.bottomLeft].map(q => [q.x, q.y]);
  const rx = p[1][0] - p[0][0], ry = p[1][1] - p[0][1];
  const rn = Math.hypot(rx, ry);
  if (rn < 1) return { rect: null, ang: 0, skew: 99 };
  const r = [rx / rn, ry / rn];
  const d = [-r[1], r[0]];                       // 條碼自己的「下方」
  const rp = p.map(q => q[0] * r[0] + q[1] * r[1]);
  const dp = p.map(q => q[0] * d[0] + q[1] * d[1]);
  const lo = a => Math.min(...a), hi = a => Math.max(...a);
  const width = hi(rp) - lo(rp), thick = hi(dp) - lo(dp);
  if (thick < 1) return { rect: null, ang: 0, skew: 99 };
  const gap = thick * 0.05, ext = thick * 1.15, side = width * 0.06;
  const corners = [];
  for (const a of [lo(rp) - side, hi(rp) + side])
    for (const b of [hi(dp) + gap, hi(dp) + gap + ext])
      corners.push([r[0] * a + d[0] * b, r[1] * a + d[1] * b]);
  const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
  const ang = Math.atan2(r[1], r[0]) * 180 / Math.PI;
  const snapped = Math.round(ang / 90) * 90;
  return {
    rect: [Math.max(0, lo(xs)), Math.max(0, lo(ys)), Math.min(W, hi(xs)), Math.min(H, hi(ys))],
    ang: snapped,
    skew: Math.abs(ang - snapped),
    bbox: [lo(p.map(q => q[0])), lo(p.map(q => q[1])), hi(p.map(q => q[0])), hi(p.map(q => q[1]))]
  };
}

/**
 * 取畫面區域內的 PDF 文字層，當輔助用。
 * 文字層**不能**代替實際印字——隱藏文字、被圖蓋住的文字一樣抽得出來——
 * 所以它只用來觸發「文字層與印字對不起來」的警告，不會用來放行。
 */
export async function pdfWords(page, rect, dpi, ang) {
  try {
    const vp = page.getViewport({ scale: dpi / 72 });
    const tc = await page.getTextContent();
    const hits = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const m = pdfjsLib.Util.transform(vp.transform, it.transform);
      const fh = Math.hypot(m[2], m[3]) || Math.hypot(m[0], m[1]);
      const w = (it.width || 0) * vp.scale;
      const x0 = m[4], y1 = m[5], y0 = y1 - fh, x1 = x0 + w;
      if (x1 < rect[0] || x0 > rect[2] || y1 < rect[1] || y0 > rect[3]) continue;
      hits.push({ x: x0, y: y0, s: it.str });
    }
    if (!hits.length) return null;
    const a = ((Math.round(ang) % 360) + 360) % 360;
    hits.sort((p, q) => (a === 0 || a === 180)
      ? (Math.round(p.y * 10) - Math.round(q.y * 10)) || (p.x - q.x)
      : (Math.round(p.x * 10) - Math.round(q.x * 10)) || (p.y - q.y));
    if (a === 180 || a === 270) hits.reverse();
    return hits.map(h => h.s).join(' ');
  } catch (e) {
    return null;                                 // 沒有文字層、或抽取失敗：就當沒有這條輔助
  }
}

export const MIN_WIDTH = 1600;   // 低於這個寬度的圖先放大，否則字太小切不出字形（與桌面版同）

/**
 * 太小的圖先放大。掃描或拍照的圖如果寬度不足，數字只有十幾個畫素高，
 * 連通域切不出字形、模板比對也沒東西可比，整份會變成一堆「待確認」。
 * 放大不會增加資訊，但能讓後面的形狀運算有足夠的取樣點——桌面版一樣是這樣處理的。
 */
export function ensureMinWidth(cv, minw = MIN_WIDTH) {
  if (cv.width >= minw) return cv;
  return upscale(cv, minw / cv.width);
}

/** 影像檔（拍照／掃描）輸入：直接當成一頁。 */
export async function imageToCanvas(file) {
  // from-image：照片的 EXIF 轉向要照做，否則直的照片會被當成橫的（桌面版用 exif_transpose）
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const cv = newCanvas(bmp.width, bmp.height);
  const c = ctx2d(cv);
  c.fillStyle = '#fff';
  c.fillRect(0, 0, cv.width, cv.height);
  c.drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  return ensureMinWidth(cv);
}

/** 放大。照片沒有「重新渲染」可言，放大只是內插，不算新證據。 */
export function upscale(src, k) {
  const cv = newCanvas(src.width * k, src.height * k);
  const c = ctx2d(cv);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}
