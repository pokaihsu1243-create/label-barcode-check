// 疊合對照圖：把程式讀到的字直接畫在印刷字身上，讓人眼可以複查程式。
// 三條帶：①印字＋條碼字疊合　②印字＋OCR字疊合　③條碼字／OCR字對位排列。
import { newCanvas, ctx2d } from './imgproc.js';

const CLR_BC = '#d60000';        // 條碼解出的字：紅
const CLR_OCR = '#0052cc';       // OCR 讀到的字：藍
const CLR_DIFF = '#d60000';      // 兩者不同的位置：紅框
const CLR_DOUBT = '#e69100';     // 程式自己也不確定的字：橘框
const LBL = ['條碼疊合', 'OCR疊合', '三排對位'];

/** 把一個字畫進指定的字框裡：字高對齊、水平置中。 */
function drawChar(c, ch, x, y, w, h, color, alpha) {
  const size = Math.max(8, Math.round(h / 0.72));
  c.save();
  c.globalAlpha = alpha;
  c.fillStyle = color;
  c.font = size + 'px Arial';
  c.textBaseline = 'alphabetic';
  const m = c.measureText(ch);
  const cw = (m.actualBoundingBoxRight || 0) + (m.actualBoundingBoxLeft || 0);
  const asc = m.actualBoundingBoxAscent || size * 0.72;
  const desc = m.actualBoundingBoxDescent || 0;
  const chh = asc + desc;
  c.fillText(ch, x + (w - cw) / 2 + (m.actualBoundingBoxLeft || 0), y + (h - chh) / 2 + asc);
  c.restore();
}

/**
 * @param crop 已轉正的文字圖
 * @param glyphs 切出來的字框
 * @param bc 條碼解出的字串；ocr OCR 讀到的字串
 * @param glyphLabels 字形覆核每個字的 [字, 把握度]
 * @param tpl 模板比對讀出的字串；tplBad 模板比對認定與條碼不符的位置
 */
export function compareImage(crop, glyphs, bc, ocr, glyphLabels, tpl, tplBad) {
  if (!glyphs || !glyphs.length) return null;
  const hs = glyphs.map(g => g.h).sort((a, b) => a - b);
  const hmed = hs[hs.length >> 1];
  // 只留文字那一塊，上下左右多餘的留白（含裁進來的標籤外框線）都切掉
  const m = Math.round(hmed * 0.30);
  const top = Math.max(0, Math.min(...glyphs.map(g => g.y)) - m);
  const bot = Math.min(crop.height, Math.max(...glyphs.map(g => g.y + g.h)) + m);
  const lft = Math.max(0, Math.min(...glyphs.map(g => g.x)) - m);
  const rgt = Math.min(crop.width, Math.max(...glyphs.map(g => g.x + g.w)) + m);
  const W = rgt - lft, H = bot - top;
  const boxes = glyphs.map(g => ({ x: g.x - lft, y: g.y - top, w: g.w, h: g.h }));

  const lsize = Math.max(18, Math.round(hmed * 0.68));
  const probe = ctx2d(newCanvas(1, 1));
  probe.font = lsize + 'px "Microsoft JhengHei", sans-serif';
  const pad = Math.round(Math.max(...LBL.map(t => probe.measureText(t).width)) + 16);
  const gapy = 10;
  const rowh = Math.round(hmed * 1.30);
  const heights = [H, H, rowh * 3];

  const out = newCanvas(W + pad, heights.reduce((a, b) => a + b, 0) + gapy * 2);
  const c = ctx2d(out);
  c.fillStyle = '#fff';
  c.fillRect(0, 0, out.width, out.height);

  const tops = [];
  let y = 0;
  for (let i = 0; i < 3; i++) { tops.push(y); y += heights[i] + (i < 2 ? gapy : 0); }

  // ①②：原圖上疊字
  for (let i = 0; i < 2; i++) {
    c.drawImage(crop, lft, top, W, H, pad, tops[i], W, H);
    const text = i === 0 ? bc : ocr;
    const col = i === 0 ? CLR_BC : CLR_OCR;
    boxes.forEach((b, k) => {
      if (k < text.length) drawChar(c, text[k], pad + b.x, tops[i] + b.y, b.w, b.h, col, 165 / 255);
    });
  }
  // ③：三排對位——第一排是原本印的字，下面兩排照著同樣的 x 位置排
  const st = tops[2];
  c.drawImage(crop, lft, top, W, H, pad, st + Math.round((rowh - H) / 2), W, H);
  boxes.forEach((b, k) => {
    if (k < bc.length)
      drawChar(c, bc[k], pad + b.x, st + rowh + ((rowh - hmed) >> 1), b.w, hmed, CLR_BC, 1);
    if (k < ocr.length)
      drawChar(c, ocr[k], pad + b.x, st + rowh * 2 + ((rowh - hmed) >> 1), b.w, hmed, CLR_OCR, 1);
  });

  // 左側標籤欄
  c.font = lsize + 'px "Microsoft JhengHei", sans-serif';
  c.textBaseline = 'top';
  [CLR_BC, CLR_OCR, '#5a5a5a'].forEach((col, i) => {
    c.fillStyle = col;
    c.fillText(LBL[i], 6, tops[i] + heights[i] / 2 - lsize * 0.62);
  });

  // 標出「與條碼不符」與「程式自己也不確定」的字
  const tb = new Set(tplBad || []);
  boxes.forEach((b, i) => {
    // 紅框＝模板比對（不經 OCR）判定這個字與條碼不符；沒有模板結果時退回字串比對
    const bad = tpl ? tb.has(i) : (i < bc.length && i < ocr.length && bc[i] !== ocr[i]);
    const [ch, cf] = glyphLabels[i] || ['?', 0];
    const doubt = ch === '?' || cf < 0.95 || (i < ocr.length && ch !== ocr[i])
      || (i < tpl.length && tpl[i] === '?');
    if (!bad && !doubt) return;
    c.strokeStyle = bad ? CLR_DIFF : CLR_DOUBT;
    c.lineWidth = bad ? 4 : 3;
    for (let k = 0; k < 2; k++)
      c.strokeRect(pad + b.x - 3, tops[k] + b.y - 3, b.w + 6, b.h + 6);
    c.strokeRect(pad + b.x - 3, st, b.w + 6, rowh * 3 - 1);
  });
  return out;
}

/**
 * 原圖對照頁：整頁原樣，在每個印刷數字正下方補上條碼解出來的數字。
 * 位置用實際切出來的字來定位（不是用文字區帶），否則會掉到下一張標籤上；
 * 方向跟著標籤本身走——原稿顛倒的，補上去的數字也跟著顛倒，
 * 讓人可以在真實版面上、用原本的閱讀方向再核一次。
 */
export function overviewImage(pageCv, marks, maxw = 1700) {
  const cv = newCanvas(pageCv.width, pageCv.height);
  const c = ctx2d(cv);
  c.drawImage(pageCv, 0, 0);
  for (const mk of marks) {
    const { ang, ox, oy, gboxes, text, status } = mk;
    if (!gboxes.length) continue;
    const a = ang * Math.PI / 180;
    const h = mk.gh;
    c.save();
    c.translate(ox, oy);
    c.rotate(a);          // 之後都用「標籤自己的」座標：+x 是閱讀方向，+y 是它自己的下方
    const col = status === 'ng' ? '#d60000' : (status === 'check' ? '#e69100' : '#0a7d32');
    const x0 = Math.min(...gboxes.map(b => b.x)) - h * 0.2;
    const x1 = Math.max(...gboxes.map(b => b.x + b.w)) + h * 0.2;
    const y0 = Math.max(...gboxes.map(b => b.y + b.h)) + h * 0.18;   // 印刷字的正下方
    // 底色先鋪白，補上去的字才不會跟原稿的線疊在一起看不清
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.fillRect(x0, y0, x1 - x0, h * 1.3);
    gboxes.forEach((b, i) => {
      if (i < text.length) drawChar(c, text[i], b.x, y0 + h * 0.15, b.w, h, col, 1);
    });
    c.strokeStyle = col;
    c.lineWidth = Math.max(1.5, h * 0.06);
    c.strokeRect(x0, y0, x1 - x0, h * 1.3);
    c.restore();
  }
  if (cv.width <= maxw) return cv;
  const out = newCanvas(maxw, cv.height * maxw / cv.width);
  const oc = ctx2d(out);
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(cv, 0, 0, out.width, out.height);
  return out;
}
