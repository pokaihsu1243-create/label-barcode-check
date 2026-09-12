// 影像處理：二值化、連通域切字、字形描述向量。
// 這裡每一步都刻意跟桌面版 (check_labels.py) 的 OpenCV 寫法一一對應——
// 因為門檻值 (SIM_TH 0.92 / TPL_MIN_MARGIN 0.02) 是在那條管線上實測校準出來的，
// 只要描述向量的算法有出入，門檻就不能沿用，等於整套要重新校準。

export const GLYPH_N = 24;          // 字形描述向量：24×24 灰階，攤平成 576 維

export function ctx2d(cv) {
  return cv.getContext('2d', { willReadFrequently: true });
}

export function newCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  return cv;
}

/** 取灰階平面（canvas 已經是灰的，直接讀 R 通道即可）。 */
export function gray(cv) {
  const { data, width: W, height: H } = ctx2d(cv).getImageData(0, 0, cv.width, cv.height);
  const g = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = data[i * 4];
  return { g, W, H };
}

/** Otsu 門檻。等同 cv2.THRESH_OTSU，不是「平均亮度打幾折」那種近似法。 */
export function otsu(g) {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const total = g.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = -1, th = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; th = t; }
  }
  return th;
}

/** THRESH_BINARY_INV + OTSU：字變成 255，背景 0。 */
export function binarize(cv) {
  const { g, W, H } = gray(cv);
  const th = otsu(g);
  const bw = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bw[i] = g[i] > th ? 0 : 255;
  return { bw, W, H };
}

/** 8 連通元件，回傳 bbox 與面積。等同 cv2.connectedComponentsWithStats(bw, 8)。 */
export function components(bw, W, H) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const out = [];
  for (let i = 0; i < W * H; i++) {
    if (!bw[i] || seen[i]) continue;
    let sp = 0;
    stack[sp++] = i; seen[i] = 1;
    let x0 = i % W, x1 = x0, y0 = (i / W) | 0, y1 = y0, area = 0;
    while (sp) {
      const p = stack[--sp], px = p % W, py = (p / W) | 0;
      area++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= W) continue;
          const q = ny * W + nx;
          if (bw[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
        }
      }
    }
    out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  return out;
}

/** cv2.INTER_AREA：縮小時做「面積加權平均」，放大時退化成最近鄰（OpenCV 的行為）。 */
export function areaResize(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const sx = sw / dw, sy = sh / dh;
  if (sx < 1 && sy < 1) {
    for (let j = 0; j < dh; j++) {
      const y = Math.min(sh - 1, (j * sy) | 0);
      for (let i = 0; i < dw; i++) out[j * dw + i] = src[y * sw + Math.min(sw - 1, (i * sx) | 0)];
    }
    return out;
  }
  for (let j = 0; j < dh; j++) {
    const ya = j * sy, yb = (j + 1) * sy;
    const j0 = Math.floor(ya), j1 = Math.min(sh, Math.ceil(yb));
    for (let i = 0; i < dw; i++) {
      const xa = i * sx, xb = (i + 1) * sx;
      const i0 = Math.floor(xa), i1 = Math.min(sw, Math.ceil(xb));
      let acc = 0, wsum = 0;
      for (let y = j0; y < j1; y++) {
        const wy = Math.min(y + 1, yb) - Math.max(y, ya);
        if (wy <= 0) continue;
        for (let x = i0; x < i1; x++) {
          const wx = Math.min(x + 1, xb) - Math.max(x, xa);
          if (wx <= 0) continue;
          acc += src[y * sw + x] * wx * wy;
          wsum += wx * wy;
        }
      }
      out[j * dw + i] = wsum > 0 ? acc / wsum : 0;
    }
  }
  return out;
}

/** 把一塊區域補成正方形（置中）再縮成 24×24、L2 正規化——這就是字形的描述向量。 */
export function descriptor(plane, W, x, y, w, h) {
  const side = Math.max(w, h);
  const pad = new Float32Array(side * side);
  const ox = (side - w) >> 1, oy = (side - h) >> 1;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++)
      pad[(oy + j) * side + ox + i] = plane[(y + j) * W + x + i];
  const v = areaResize(pad, side, side, GLYPH_N, GLYPH_N);
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n < 1e-6) return null;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * 切出一排字。回傳 [{x,y,w,h,v}]，依 x 排序。
 *
 * 字高基準取「同高元件最多的那一群」，不用中位數——中位數會被裁進來的標籤外框線
 * 與條碼底部餘料帶歪（桌面版實測整排數字因此被濾光），但一整排數字永遠是同高最多的一群。
 */
export function segmentGlyphs(cv) {
  const { bw, W, H } = binarize(cv);
  const comps = components(bw, W, H).filter(
    c => !(c.h > H * 0.85 || c.w > W * 0.4 || c.w > c.h * 3 || c.h < 3 || c.area < 12));
  if (!comps.length) return [];
  let hmed = comps[0].h, best = 0;
  for (const c of comps) {
    let n = 0;
    for (const o of comps) if (o.h >= c.h * 0.8 && o.h <= c.h * 1.25) n++;
    if (n > best) { best = n; hmed = c.h; }
  }
  const out = [];
  for (const c of comps) {
    if (c.h < hmed * 0.55 || c.h > hmed * 1.8 || c.w > hmed * 2.5) continue;
    const v = descriptor(bw, W, c.x, c.y, c.w, c.h);
    if (v) out.push({ x: c.x, y: c.y, w: c.w, h: c.h, v });
  }
  out.sort((a, b) => a.x - b.x);
  return out;
}

/**
 * 從切出來的一堆字裡挑出「條碼下方那一整行」。
 *
 * 為什麼需要這一步：文字常常比條碼圖案寬（QR 碼更明顯，它是方的，下面那行料號
 * 動輒寬上好幾倍）。所以取文字區時要往左右多抓一些，但多抓就可能連到旁邊的東西。
 * 這裡的做法是「先寬鬆地抓，再依實際的字把範圍收回來」：
 *   ① 只留同一行的字（垂直中心相近的）
 *   ② 沿著水平方向連成一串，字距太大就斷開——那是另一個區塊，不是同一串料號
 *   ③ 取包含「條碼正下方」那一串；沒有就取最長的一串
 *
 * @param glyphs segmentGlyphs() 的結果
 * @param centerX 條碼中心在這張裁切圖裡的 x（用來認哪一串才是「它自己的」那串）
 */
export function pickTextLine(glyphs, centerX) {
  if (glyphs.length < 2) return glyphs;
  const hs = glyphs.map(g => g.h).sort((a, b) => a - b);
  const hm = hs[hs.length >> 1];
  const cys = glyphs.map(g => g.y + g.h / 2).sort((a, b) => a - b);
  const cy = cys[cys.length >> 1];
  const line = glyphs.filter(g => Math.abs(g.y + g.h / 2 - cy) <= hm * 0.6)
                     .sort((a, b) => a.x - b.x);
  if (line.length < 2) return line;

  // 字距超過 2 個字高就視為斷開。同一串料號裡就算有空格也不會到這麼寬，
  // 但跨到另一個欄位／另一張標籤的間隔一定超過。
  const runs = [[line[0]]];
  for (let i = 1; i < line.length; i++) {
    const prev = line[i - 1];
    const gap = line[i].x - (prev.x + prev.w);
    if (gap > hm * 2.0) runs.push([line[i]]);
    else runs[runs.length - 1].push(line[i]);
  }
  if (centerX != null) {
    const hit = runs.find(r => {
      const a = r[0].x, b = r[r.length - 1].x + r[r.length - 1].w;
      return centerX >= a - hm && centerX <= b + hm;
    });
    if (hit) return hit;
  }
  return runs.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * 緊貼文字裁切。不這樣做的話，文字在 OCR 的 48px 輸入裡只佔一半高度，
 * CTC 會把相鄰相同的字（例如 77）併成一個——實測 277 被讀成 27。
 * 桌面版是靠 RapidOCR 內建的文字偵測自動達成同樣效果，這裡得自己來。
 */
export function tightCrop(cv, glyphs) {
  const gl = glyphs || segmentGlyphs(cv);
  if (!gl.length) return cv;
  const hm = gl.map(g => g.h).sort((a, b) => a - b)[gl.length >> 1];
  const m = Math.round(hm * 0.28);
  const x0 = Math.max(0, Math.min(...gl.map(g => g.x)) - m);
  const y0 = Math.max(0, Math.min(...gl.map(g => g.y)) - m);
  const x1 = Math.min(cv.width, Math.max(...gl.map(g => g.x + g.w)) + m);
  const y1 = Math.min(cv.height, Math.max(...gl.map(g => g.y + g.h)) + m);
  const t = newCanvas(x1 - x0, y1 - y0);
  ctx2d(t).drawImage(cv, x0, y0, t.width, t.height, 0, 0, t.width, t.height);
  return t;
}
