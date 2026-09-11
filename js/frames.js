// 抓 PDF 裡「畫出來的」標籤外框（只取線框，不取填色區塊），用來把條碼分組成同一張標籤。
// 分組只影響兩件事：報表的排序，以及「某張標籤比別張少一個條碼」這則提示。
// 抓不到框就退回純幾何排序、並且不發那則提示——寧可少講一句話，也不要講一句沒根據的。
import { pdfjsLib } from './pdfio.js';

const OPS = pdfjsLib.OPS;

export async function labelFrames(page, dpi) {
  try {
    const vp = page.getViewport({ scale: dpi / 72 });
    const ol = await page.getOperatorList();
    const out = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    let pending = null;

    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i], args = ol.argsArray[i];
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = pdfjsLib.Util.transform(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) {
        // Illustrator 匯出的 PDF 幾乎都把內容包在 Form XObject 裡，
        // 它自帶一個矩陣；不跟著推進去的話，裡面所有路徑的座標都會算錯。
        stack.push(ctm.slice());
        if (args && args[0]) ctm = pdfjsLib.Util.transform(ctm, args[0]);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.constructPath) {
        // args = [ops, coords, minMax]。coords **不是**單純的 x,y 對——
        // 矩形 (OPS 19) 的四個數字是 x,y,寬,高，照 x,y 對去算會得到完全錯的框。
        // 第三個參數就是這條路徑自己的 [minX,minY,maxX,maxY]，直接用它。
        const mm = args && args[2];
        pending = (mm && mm.length === 4 && mm.every(v => isFinite(v))) ? Array.from(mm) : null;
      } else if (fn === OPS.stroke || fn === OPS.closeStroke
                 || fn === OPS.closeFillStroke || fn === OPS.fillStroke
                 || fn === OPS.eoFillStroke || fn === OPS.closeEOFillStroke) {
        if (pending) {
          const m = pdfjsLib.Util.transform(vp.transform, ctm);
          const pts = [[pending[0], pending[1]], [pending[2], pending[1]],
                       [pending[2], pending[3]], [pending[0], pending[3]]]
            .map(([x, y]) => pdfjsLib.Util.applyTransform([x, y], m));
          const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
          const r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
          // 門檻與桌面版一致：寬 120pt、高 60pt 以上才算標籤外框
          if (r[2] - r[0] > 120 * dpi / 72 && r[3] - r[1] > 60 * dpi / 72) out.push(r);
        }
        pending = null;
      } else if (fn === OPS.fill || fn === OPS.eoFill) {
        pending = null;                       // 填色區塊不算外框
      }
    }
    // 先小後大：ownerLabel 取第一個包住它的框，框有巢狀時要讓最小的那個贏。
    // 面積相同時再照版面位置排（上到下、左到右），編號才會跟人看的順序一致。
    out.sort((a, b) => ((a[2] - a[0]) * (a[3] - a[1]) - (b[2] - b[0]) * (b[3] - b[1]))
      || (a[1] - b[1]) || (a[0] - b[0]));
    return out;
  } catch (e) {
    return [];
  }
}

export function ownerLabel(bbox, frames) {
  const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f[0] <= cx && cx <= f[2] && f[1] <= cy && cy <= f[3]) return i;
  }
  return -1;
}
