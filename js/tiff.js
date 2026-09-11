// TIFF 解碼。瀏覽器本身不認 TIFF（createImageBitmap 會直接失敗），
// 但掃描器與不少排版軟體輸出的就是 TIFF，而且常常是多頁的——一頁一張標籤稿。
// 桌面版靠 PIL 的 ImageSequence 逐頁跑，這裡用 UTIF 做同樣的事。
//
// UTIF 與 pako 是傳統 script（掛在 window 上），不是 ES module，所以用插 <script> 的方式載；
// 而且只有真的丟 TIFF 進來時才載，平常不佔頻寬。
import { newCanvas, ctx2d } from './imgproc.js';

let loading = null;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error('載入不到 TIFF 解碼程式：' + url));
    document.head.appendChild(s);
  });
}

async function ensure() {
  if (window.UTIF) return;
  if (!loading) {
    loading = (async () => {
      // pako 只有「Deflate 壓縮的 TIFF」才用得到，但它很小，一起載比事後才發現讀不了好
      await loadScript(new URL('../vendor/pako/pako.min.js', import.meta.url).href);
      await loadScript(new URL('../vendor/utif/UTIF.js', import.meta.url).href);
    })();
  }
  await loading;
  if (!window.UTIF) throw new Error('TIFF 解碼程式載入後仍不可用');
}

export function isTiff(file) {
  return /\.tiff?$/i.test(file.name) || file.type === 'image/tiff';
}

/** 解出 TIFF 的每一頁，回傳 canvas 陣列（多頁 TIFF 會全部解，不是只解第一頁）。 */
export async function decodeTiff(buf) {
  await ensure();
  const u8 = new Uint8Array(buf);
  const ifds = window.UTIF.decode(u8);
  const out = [];
  for (const ifd of ifds) {
    try {
      window.UTIF.decodeImage(u8, ifd, ifds);
      const rgba = window.UTIF.toRGBA8(ifd);
      const w = ifd.width, h = ifd.height;
      if (!w || !h || !rgba || !rgba.length) continue;
      const cv = newCanvas(w, h);
      const c = ctx2d(cv);
      const im = c.createImageData(w, h);
      im.data.set(rgba);
      c.putImageData(im, 0, 0);
      out.push(cv);
    } catch (e) {
      // 某一頁壞掉不該讓整份都讀不了；讀不到的頁數後面會反映在「掃不到條碼」的警告上
      console.warn('TIFF 有一頁解不開：', e);
    }
  }
  if (!out.length) throw new Error('這個 TIFF 解不開（可能是不支援的壓縮方式）');
  return out;
}
