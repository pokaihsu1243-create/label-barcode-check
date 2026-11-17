// PP-OCRv3 文字辨識（就是桌面版 RapidOCR 用的同一個 ch_PP-OCRv3_rec_infer.onnx）。
// 選它而不是 Tesseract 的理由，除了實測劣化時多撐一級、快 6 倍之外，
// 最重要的是「同一個模型」——桌面版校準好的門檻可以直接沿用。
import { newCanvas, ctx2d, tightCrop } from './imgproc.js';

const MODEL = 'models/ppocr_v3_rec.onnx';
const KEYS = 'models/ppocr_keys.txt';
// 模型自己存在瀏覽器的 Cache Storage，不靠一般的 HTTP 快取。
// GitHub Pages 對所有檔案只給 10 分鐘快取，而且每次推新版 ETag 都會跟著變；
// 實測重新整理一次就又整包重抓 9.5MB（約 15～30 秒），使用者每次放檔案都在等這個。
// 換模型檔時要改這個名字，舊的那份會在 init 時清掉。
const MODEL_CACHE = 'label-check-model-ppocr_v3_rec-1';
const REC_H = 48;                  // PaddleOCR 辨識模型固定的輸入高度

let ort = null, session = null, keys = null, loading = null;

/** 全形折半形。PP-OCR 的字典同時收全形與半形，影像差時會吐出全形數字（２7７０…）。
 *  逐字折並只接受「一換一且結果是 ASCII」，避免 ㎏→kg 這種會改變字數的相容分解
 *  破壞後面字形票數的逐字對位。桌面版 2026-09-12 也補了同樣的處理。 */
export function fold(s) {
  let out = '';
  for (const ch of (s || '')) {
    const c = ch.normalize('NFKC');
    out += (c.length === 1 && /^[\x00-\x7F]$/.test(c)) ? c : ch;
  }
  return out;
}

export function norm(s) {
  return fold(s).replace(/\s+/g, '');
}

export function ready() {
  return !!session;
}

/** 下載模型並回報已下載幾 MB。
 *  不用 Content-Length 算百分比：GitHub Pages 會壓縮傳送，那是壓縮後的大小，跟收到的位元組數對不起來。 */
async function download(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('讀不到辨識模型 ' + MODEL);
  if (!r.body) return new Uint8Array(await r.arrayBuffer());
  const rd = r.body.getReader(), parts = [];
  let got = 0, shown = -1;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    const mb = Math.floor(got / 1048576);
    if (mb !== shown && onProgress) {
      shown = mb;
      onProgress(`下載辨識模型 ${mb} / 約 10 MB（只有第一次要下載，之後存在這台電腦）…`);
    }
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}

/** 模型的位元組：Cache Storage 有就直接拿，沒有才下載並存起來。 */
async function modelBytes(onProgress) {
  const url = new URL('../' + MODEL, import.meta.url).href;
  let cache = null;
  try {
    for (const k of await caches.keys())
      if (k.startsWith('label-check-model-') && k !== MODEL_CACHE) await caches.delete(k);
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    if (hit) {
      onProgress && onProgress('載入辨識模型（已存在這台電腦，不必重新下載）…');
      return new Uint8Array(await hit.arrayBuffer());
    }
  } catch (e) { cache = null; }      // 無痕視窗、儲存空間被擋：照樣能用，只是每次都要下載
  const bytes = await download(url, onProgress);
  if (cache) {
    try {
      await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
    } catch (e) { /* 存不進去就算了，下次再下載 */ }
  }
  return bytes;
}

export async function init(onProgress) {
  if (session) return;
  if (loading) return loading;
  loading = (async () => {
    onProgress && onProgress('準備辨識模型…');
    // 一樣自己託管。注意要用 .mjs（ES module）——.js 是 UMD 版，沒有 ort.env 可以設。
    ort = await import('../vendor/ort/ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
    ort.env.wasm.numThreads = 1;     // GitHub Pages 設不了 COOP/COEP，沒有 SharedArrayBuffer
    const bytes = await modelBytes(onProgress);
    onProgress && onProgress('啟動辨識模型…');
    const [s, txt] = await Promise.all([
      ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }),
      fetch(KEYS).then(r => {
        if (!r.ok) throw new Error('讀不到字典檔 ' + KEYS);
        return r.text();
      })
    ]);
    session = s;
    // 字典排法與 RapidOCR 一致：0 號是 CTC 的 blank，最後補一個半形空白
    keys = ['<blank>', ...txt.split('\n').map(l => l.replace(/\r$/, '')), ' '];
  })();
  try {
    await loading;
  } finally {
    loading = null;
  }
}

/**
 * 讀一張已經轉正的文字圖，回傳 { text, score, raw }。
 * score 的算法與 RapidOCR 相同：CTC 去重去 blank 後，被保留的每個時間步的最大機率取平均，
 * 這樣 MIN_SCORE=0.80 這個門檻才跟桌面版同一把尺。
 */
export async function recognize(cv, glyphs) {
  if (!session) throw new Error('辨識模型尚未載入');
  const src = tightCrop(cv, glyphs);
  const W = Math.max(16, Math.min(1600, Math.round(src.width * REC_H / src.height)));
  const r = newCanvas(W, REC_H);
  const rc = ctx2d(r);
  rc.fillStyle = '#fff';
  rc.fillRect(0, 0, W, REC_H);
  rc.drawImage(src, 0, 0, W, REC_H);
  const d = rc.getImageData(0, 0, W, REC_H).data;

  const plane = REC_H * W;
  const t = new Float32Array(3 * plane);
  for (let y = 0; y < REC_H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, o = y * W + x;
      t[o] = (d[i] / 255 - 0.5) / 0.5;                 // PaddleOCR 的標準前處理
      t[plane + o] = (d[i + 1] / 255 - 0.5) / 0.5;
      t[2 * plane + o] = (d[i + 2] / 255 - 0.5) / 0.5;
    }
  }
  const out = await session.run({ x: new ort.Tensor('float32', t, [1, 3, REC_H, W]) });
  const o = out[Object.keys(out)[0]];
  const [, T, C] = o.dims;

  let raw = '', last = -1, probSum = 0, probN = 0;
  for (let i = 0; i < T; i++) {
    let bi = 0, bv = -1;
    for (let c = 0; c < C; c++) {
      const v = o.data[i * C + c];
      if (v > bv) { bv = v; bi = c; }
    }
    if (bi !== 0 && bi !== last) {
      raw += (keys[bi] ?? '');
      probSum += bv;
      probN++;
    }
    last = bi;
  }
  return { text: norm(raw), raw, score: probN ? probSum / probN : 0 };
}
