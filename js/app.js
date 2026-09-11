// 主流程：把一份標籤稿從頭走到尾，產出每一列的判定與對照圖。
// 四條軌：①條碼解碼（不經 OCR）②兩個解析度各一次 OCR ③字形群聚覆核 ④模板疊合比對（不經 OCR）。
import { readBarcodes, prepareZXingModule } from '../vendor/zxing/es/reader/index.js';
import { segmentGlyphs, ctx2d, newCanvas } from './imgproc.js';
import * as ocr from './ocr.js';
import { templateRead } from './template.js';
import { shapeRead, finalize, tplNote, MAX_SKEW } from './verdict.js';
import { compareImage, overviewImage } from './overlay.js';
import * as io from './pdfio.js';
import { labelFrames, ownerLabel } from './frames.js';

export const DPI = 400;              // 主要解析度（與桌面版相同）
export const DPI_HI = 800;           // 第二次獨立判讀的解析度

// zxing 的 wasm 預設會去 CDN 抓，改成抓自己 vendor 目錄裡那份
prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) => path.endsWith('.wasm')
      ? new URL('../vendor/zxing/zxing_reader.wasm', import.meta.url).href
      : prefix + path
  }
});

const png = cv => cv.toDataURL('image/png');

/** 整份檔的結論與燈號。放行只給「乾淨且總數已核對」。 */
export function summarize(rows, warns, counted) {
  const ng = rows.filter(r => r.verdict === 'NG').length;
  const chk = rows.filter(r => r.verdict !== 'OK' && r.verdict !== 'NG').length;
  const clean = rows.length > 0 && rows.every(r => r.verdict === 'OK') && !warns.length;
  if (clean && counted) return { text: '全部一致，可以放行', level: 'ok', ng, chk };
  if (clean) return { text: '已辨識項目一致，但總數未核對——請填入應有條碼總數再確認一次', level: 'warn', ng, chk };
  return { text: '發現異常，先別開印', level: 'bad', ng, chk };
}

export async function check(file, expectTotal, progress) {
  const say = m => progress && progress(m);
  await ocr.init(say);

  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  const rows = [], warns = [], pages = [];

  if (isPdf) {
    const pdf = await io.openPdf(await file.arrayBuffer());
    for (let n = 1; n <= pdf.numPages; n++) {
      say(`第 ${n}/${pdf.numPages} 頁：渲染中…`);
      const page = await pdf.getPage(n);
      pages.push({ no: n, page, cv: await io.renderPage(page, DPI) });
    }
  } else {
    pages.push({ no: 1, page: null, cv: await io.imageToCanvas(file) });
  }

  for (const pg of pages) {
    say(`第 ${pg.no}/${pages.length} 頁：解條碼…`);
    const W = pg.cv.width, H = pg.cv.height;
    const imgData = ctx2d(pg.cv).getImageData(0, 0, W, H);
    const found = await readBarcodes(imgData, { tryHarder: true, maxNumberOfSymbols: 64 });

    // 同一個條碼被重複回報時只留一個（中心點 20px 內視為同一個）
    const items = [], seen = [];
    for (const r of found) {
      const p = [r.position.topLeft, r.position.topRight, r.position.bottomRight, r.position.bottomLeft];
      const cx = p.reduce((a, q) => a + q.x, 0) / 4, cy = p.reduce((a, q) => a + q.y, 0) / 4;
      if (seen.some(s => Math.abs(s[0] - cx) < 20 && Math.abs(s[1] - cy) < 20)) continue;
      seen.push([cx, cy]);
      const bbox = [Math.min(...p.map(q => q.x)), Math.min(...p.map(q => q.y)),
                    Math.max(...p.map(q => q.x)), Math.max(...p.map(q => q.y))];
      items.push({ r, bbox });
    }
    if (!items.length)
      warns.push(`第 ${pg.no} 頁：完全掃不到條碼，請確認是否為條碼稿、或線條太細。`);

    const frames = pg.page ? await labelFrames(pg.page, DPI) : [];
    items.forEach(it => { it.label = ownerLabel(it.bbox, frames); });
    items.sort((a, b) => a.label - b.label || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);

    const pageRows = [];
    for (let i = 0; i < items.length; i++) {
      say(`第 ${pg.no} 頁：辨識第 ${i + 1}/${items.length} 個條碼…`);
      const { r, bbox, label } = items[i];
      const g = io.textGeom(r.position, W, H);
      const row = {
        page: pg.no, label: label + 1, fmt: String(r.format),
        bc: ocr.norm(r.text), bcRaw: r.text, orient: ((g.ang % 360) + 360) % 360, skew: g.skew,
        ocr: '', ocr2: '', raw: '', score: 0, shape: '', shapeConf: 0,
        verdict: 'CHECK', reason: '', glyphs: [], dpi: DPI, dpiHi: DPI_HI,
        tpl: '', tplLo: '', tplHi: '', tplBad: [], tplMargin: 0, tplResConflict: [], tplFilled: []
      };

      if (!g.rect || g.skew > MAX_SKEW) {
        row.reason = `條碼傾斜 ${g.skew.toFixed(1)}°，無法可靠對位`;
        row.img = png(io.cropCanvas(pg.cv, bbox));
        rows.push(row); pageRows.push(row);
        continue;
      }

      const crop = io.upright(io.cropCanvas(pg.cv, g.rect), g.ang);
      const glyphs = segmentGlyphs(crop);
      row.glyphs = glyphs;

      // 文字層只當輔助：隱藏文字、被蓋住的文字都抽得出來，不能代替實際印字
      const wtext = pg.page ? await io.pdfWords(pg.page, g.rect, DPI, g.ang) : null;
      row.pdfText = wtext == null ? null : ocr.norm(wtext);

      const a = await ocr.recognize(crop, glyphs);
      // PDF 的 800dpi 是真的重新渲染，資訊量確實增加；照片放大只是內插，沒有新資訊
      const hiReal = !!pg.page;
      const cropHi = hiReal
        ? io.upright(await io.renderRegion(pg.page, DPI_HI, g.rect, DPI), g.ang)
        : io.upscale(crop, 2);
      const glyphsHi = segmentGlyphs(cropHi);
      const b = await ocr.recognize(cropHi, glyphsHi);
      row.raw = a.raw;
      row.ocr = a.text;
      row.ocr2 = b.text;
      row.score = Math.min(a.score, b.score);
      row._crop = crop;
      row._glyphsHi = glyphsHi;
      row._hiReal = hiReal;
      row._geom = g;
      row.img = png(io.upright(io.cropCanvas(pg.cv, [
        Math.min(bbox[0], g.rect[0]) - 10, Math.min(bbox[1], g.rect[1]) - 10,
        Math.max(bbox[2], g.rect[2]) + 10, Math.max(bbox[3], g.rect[3]) + 10]), g.ang));
      rows.push(row);
      pageRows.push(row);
    }

    // 標籤間的數量落差——只能當「提示」，不能當數量已核對。
    // 每張標籤都漏讀同樣數量時，眾數會跟著一起錯，這個方法看不出來。
    if (frames.length) {
      const cnt = new Map();
      for (let i = 0; i < frames.length; i++) cnt.set(i + 1, 0);
      pageRows.forEach(r => cnt.set(r.label, (cnt.get(r.label) || 0) + 1));
      // 眾數只在「有掃到條碼」的標籤之間取。把 0 也算進去的話，
      // 整排標籤都沒掃到時 0 反而變成眾數，這則提示就永遠不會發出來。
      const vals = [...cnt.values()].filter(v => v > 0);
      const tally = new Map();
      vals.forEach(v => tally.set(v, (tally.get(v) || 0) + 1));
      const mode = [...tally.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
      [...cnt.entries()].sort((a, b) => a[0] - b[0]).forEach(([lb, v]) => {
        if (mode && v !== mode)
          warns.push(`提示：第 ${pg.no} 頁第 ${lb} 張標籤只掃到 ${v} 個條碼（其他標籤是 ${mode} 個）`
            + `——很可能有條碼印不出來或品質不良，請人工確認。`);
      });
    }
  }

  // 字形覆核（整份檔一起做，才有足夠的實例可以互相佐證）
  let nclu = 0;
  if (rows.some(r => r.glyphs && r.glyphs.length)) {
    say('字形覆核…');
    nclu = shapeRead(rows);
  }

  // 模板疊合比對 + 定案
  for (const r of rows) {
    const gl = r.glyphs || [];
    if (gl.length && gl.length === r.bc.length) {
      // 兩個解析度都跑，不是「只在不方便時才重試」——否則 400dpi 讀錯但讀得很完整的列
      // 永遠不會被複查，等於只在對自己有利時才複查。成本可以忽略（每字 36 次內積）。
      const lo = templateRead(gl);
      const hiGl = r._glyphsHi || [];
      const hi = hiGl.length === r.bc.length ? templateRead(hiGl) : { text: '', margins: [] };
      const n = lo.text.length;
      r.tplResConflict = [];
      for (let i = 0; i < Math.min(n, hi.text.length); i++)
        if (lo.text[i] !== '?' && hi.text[i] !== '?' && lo.text[i] !== hi.text[i]) r.tplResConflict.push(i);
      let merged = '';
      const margins = [], filled = [];
      for (let i = 0; i < n; i++) {
        const cLo = lo.text[i], cHi = i < hi.text.length ? hi.text[i] : '?';
        if (cLo !== '?') { merged += cLo; margins.push(lo.margins[i]); }
        else if (cHi !== '?' && r._hiReal) {
          // 只有 PDF 的 800dpi 算「新證據」；照片放大是內插，不能拿來把 CHECK 升級
          merged += cHi; margins.push(hi.margins[i]); filled.push(i);
        } else { merged += '?'; margins.push(lo.margins[i]); }
      }
      r.tpl = merged;
      r.tplLo = lo.text;
      r.tplHi = hi.text;
      r.tplFilled = filled;
      r.tplMargin = margins.length ? Math.min(...margins) : 0;
      r.tplBad = [...merged].map((c, i) => (c !== '?' && c !== r.bc[i]) ? i : -1).filter(i => i >= 0);
    }
    finalize(r);
    r.tplNote = tplNote(r);
    if (r._crop && gl.length) {
      const im = compareImage(r._crop, gl, r.bc, r.ocr, r.glyphLabels || [], r.tpl, r.tplBad);
      if (im) r.cmp = png(im);
    }
  }

  // 原圖對照頁：在真實版面上、用原本的閱讀方向再核一次
  say('產生原圖對照頁…');
  const overviews = pages.map(pg => {
    const marks = rows.filter(r => r.page === pg.no && r._geom && (r.glyphs || []).length)
      .map(r => {
        const g = r._geom, a = g.ang * Math.PI / 180;
        const rh = [Math.cos(a), Math.sin(a)], dh = [-rh[1], rh[0]];
        const corners = [[g.rect[0], g.rect[1]], [g.rect[2], g.rect[1]],
                         [g.rect[2], g.rect[3]], [g.rect[0], g.rect[3]]];
        const key = corners.map(c => c[0] * rh[0] + c[1] * rh[1] + c[0] * dh[0] + c[1] * dh[1]);
        const origin = corners[key.indexOf(Math.min(...key))];   // 條碼自身座標的原點（左上）
        const hs = r.glyphs.map(x => x.h).sort((p, q) => p - q);
        return {
          ang: g.ang, ox: origin[0], oy: origin[1], gh: hs[hs.length >> 1],
          gboxes: r.glyphs.map(x => ({ x: x.x, y: x.y, w: x.w, h: x.h })),
          text: r.bc,
          status: r.verdict === 'NG' ? 'ng' : (r.verdict === 'OK' ? 'ok' : 'check')
        };
      });
    return { no: pg.no, img: png(overviewImage(pg.cv, marks)) };
  });

  rows.forEach(r => { delete r._crop; delete r._glyphsHi; delete r._geom; delete r.glyphs; });

  let counted = false;
  if (expectTotal) {
    counted = true;
    if (rows.length !== expectTotal)
      warns.push(`應有 ${expectTotal} 個條碼，實際只解出 ${rows.length} 個——`
        + `差額 ${Math.abs(expectTotal - rows.length)} 個請人工確認。`);
  }
  return { rows, warns, counted, nclu, overviews, summary: summarize(rows, warns, counted) };
}
