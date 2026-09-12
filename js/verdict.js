// 判定：字形群聚覆核 + 定案規則。與桌面版 shape_read() / finalize() 逐條對應。
//
// 判定原則：OK 只給「有兩條互相獨立的證據支持」的列，其餘一律 CHECK，並寫清楚是哪一種不確定。
// 反過來說，某一軌稍有瑕疵而其他軌都吻合時不該叫人——那只會製造雜訊，
// 看久了就會開始無視真正的警告。
import { dot } from './imgproc.js';
import { TPL_MIN_MARGIN } from './template.js';

export const SIM_TH = 0.92;              // 字形分群的相似度門檻
export const SIZE_LO = 0.80, SIZE_HI = 1.25;   // 同一群允許的字高比例範圍
export const GLYPH_PURITY = 0.80;        // 群聚多數決的最低得票比例
export const VOTE_MIN = 2;               // 一個字形至少要被幾個實例投票才採信
export const MIN_SCORE = 0.80;           // OCR 信心門檻
export const MAX_SKEW = 5.0;             // 條碼傾斜超過幾度就不判讀

/**
 * 把整份檔的字依形狀分群，同一形狀的所有實例用 OCR 票多數決定它是哪個字。
 * 票數不足、平手、得票比例不足 → 該字標 '?'，該列後續會判 CHECK。
 *
 * 注意：這一軌的票源是 OCR，所以它**不是**獨立於 OCR 的證據；
 * 它能抓的是「同一個形狀在不同地方被讀成不同字」這種前後矛盾。
 */
export function shapeRead(rows) {
  const cents = [], counts = [], members = [], sizes = [];
  rows.forEach((r, ri) => {
    (r.glyphs || []).forEach((g, gi) => {
      let best = -1, bi = -1;
      for (let ci = 0; ci < cents.length; ci++) {
        const ratio = sizes[ci] ? g.h / sizes[ci] : 0;
        if (ratio < SIZE_LO || ratio > SIZE_HI) continue;   // 字級不同就不比，避免跨字級誤併
        const s = dot(g.v, cents[ci]);
        if (s > best) { best = s; bi = ci; }
      }
      if (best >= SIM_TH) {
        const k = counts[bi], c = cents[bi];
        let n = 0;
        for (let i = 0; i < c.length; i++) { c[i] = (c[i] * k + g.v[i]) / (k + 1); n += c[i] * c[i]; }
        n = Math.sqrt(n) || 1e-6;
        for (let i = 0; i < c.length; i++) c[i] /= n;
        sizes[bi] = (sizes[bi] * k + g.h) / (k + 1);
        counts[bi] = k + 1;
        members[bi].push([ri, gi]);
      } else {
        cents.push(Float32Array.from(g.v));
        counts.push(1);
        sizes.push(g.h);
        members.push([[ri, gi]]);
      }
    });
  });

  const labels = [], confs = [];
  members.forEach(mem => {
    const votes = new Map();
    for (const [ri, gi] of mem) {
      const t = rows[ri].ocr || '';
      if ((rows[ri].glyphs || []).length === t.length && gi < t.length)
        votes.set(t[gi], (votes.get(t[gi]) || 0) + 1);
    }
    if (!votes.size) { labels.push('?'); confs.push(0); return; }
    const ordered = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    const [ch, cnt] = ordered[0];
    const tot = [...votes.values()].reduce((a, b) => a + b, 0);
    const tie = ordered.length > 1 && ordered[1][1] === cnt;
    const purity = cnt / tot;
    labels.push((cnt >= VOTE_MIN && !tie && purity >= GLYPH_PURITY) ? ch : '?');
    confs.push(purity);
  });

  const of = new Map();
  members.forEach((mem, ci) => mem.forEach(([ri, gi]) => of.set(ri + ':' + gi, ci)));
  rows.forEach((r, ri) => {
    const gl = r.glyphs || [];
    if (!gl.length) { r.shape = ''; r.shapeConf = 0; r.glyphLabels = []; return; }
    const chars = [], cf = [];
    for (let gi = 0; gi < gl.length; gi++) {
      const ci = of.get(ri + ':' + gi);
      chars.push(ci === undefined ? '?' : labels[ci]);
      cf.push(ci === undefined ? 0 : confs[ci]);
    }
    r.shape = chars.join('');
    r.shapeConf = cf.length ? Math.min(...cf) : 0;
    r.glyphLabels = chars.map((c, i) => [c, cf[i]]);
  });
  return cents.length;
}

const pos1 = arr => arr.map(i => i + 1).join('、');

/**
 * 編輯距離對齊（Needleman–Wunsch，等權重）。
 * 回傳每一步是「相同／換成別的字／OCR 缺字／OCR 多字」。
 */
function editOps(a, b) {
  const n = a.length, m = b.length;
  const D = [];
  for (let i = 0; i <= n; i++) {
    D.push(new Int32Array(m + 1));
    D[i][0] = i;
  }
  for (let j = 0; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      D[i][j] = Math.min(D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
                         D[i - 1][j] + 1,
                         D[i][j - 1] + 1);
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      ops.push({ kind: a[i - 1] === b[j - 1] ? 'same' : 'sub', i: i - 1, bc: a[i - 1], ocr: b[j - 1] });
      i--; j--;
    } else if (i > 0 && D[i][j] === D[i - 1][j] + 1) {
      ops.push({ kind: 'del', i: i - 1, bc: a[i - 1], ocr: null });   // 條碼有這個字，OCR 沒讀到
      i--;
    } else {
      ops.push({ kind: 'ins', i, bc: null, ocr: b[j - 1] });          // OCR 多出一個字
      j--;
    }
  }
  return { dist: D[n][m], ops: ops.reverse() };
}

/**
 * 逐字列出「條碼」與「OCR」對不起來的地方。
 *
 * **字數不同時一定要先對齊再比**：OCR 只要漏掉開頭一個字，逐位比對就會讓後面
 * 每一個字都錯位，變成列出一整排根本不存在的「錯字」，反而害人找錯地方。
 *
 * 對齊只用於顯示：**不會去補改 OCR 原文，也不參與判定**。證據不足時判定仍是
 * 待確認，不會因為這裡列出（或沒列出）差異就變成 OK 或 NG。
 *
 * 對齊本身不唯一時（例如缺的那個字夾在一串相同的字裡，分不出是哪一個被漏掉，
 * 或是兩邊差太多根本對不起來），就不硬指位置，改成請人工確認。
 */
export function charMismatches(bc, ocr) {
  bc = bc || '';
  ocr = ocr || '';
  if (bc === ocr) return { count: 0, items: [], unclear: false, lenNote: '' };

  const lenNote = bc.length === ocr.length ? ''
    : `OCR 比條碼${ocr.length < bc.length ? '少' : '多'} ${Math.abs(bc.length - ocr.length)} 個字`
      + `（條碼 ${bc.length} 字／OCR ${ocr.length} 字）`;

  if (bc.length === ocr.length) {              // 字數相同：逐位比對本來就沒有歧義
    const items = [];
    for (let i = 0; i < bc.length; i++)
      if (bc[i] !== ocr[i]) items.push({ kind: 'sub', i, bc: bc[i], ocr: ocr[i] });
    return { count: items.length, items, unclear: false, lenNote };
  }

  const { dist, ops } = editOps(bc, ocr);
  const items = ops.filter(o => o.kind !== 'same');

  // 差太多就別硬對——對出來的位置沒有意義，講「請人工確認」還比較誠實
  const tooFar = dist > Math.max(3, Math.ceil(bc.length * 0.4));
  // 缺字／多字若落在一串相同的字裡，滑一格也是同樣的距離，位置就不唯一
  const slippery = items.some(o => {
    if (o.kind === 'sub') return false;
    const s = o.kind === 'del' ? bc : ocr;
    const k = o.kind === 'del' ? o.i : ocr.indexOf(o.ocr, Math.max(0, o.i - 1));
    return (k > 0 && s[k - 1] === s[k]) || (k >= 0 && k + 1 < s.length && s[k + 1] === s[k]);
  });
  const unclear = tooFar || slippery;
  return { count: items.length, items: unclear ? [] : items, unclear, lenNote, dist };
}

export function mismatchText(m) {
  const n = m.i + 1;
  if (m.kind === 'del') return `第 ${n} 字：條碼為 ${m.bc}，OCR 沒讀到這個字`;
  if (m.kind === 'ins') return m.i === 0 ? `開頭：OCR 多出一個 ${m.ocr}`
                                         : `第 ${m.i} 字之後：OCR 多出一個 ${m.ocr}`;
  return `第 ${n} 字：條碼為 ${m.bc}，OCR 為 ${m.ocr}`;
}

/** 定案。OK 只給有兩條互相獨立證據的列，其餘一律 CHECK 並寫明原因。 */
export function finalize(r) {
  if (r.verdict === 'CHECK' && r.reason) return;      // 傾斜等前面已判定的情況
  const bc = r.bc, tx = r.ocr;
  if (!tx) { r.verdict = 'NOTEXT'; r.reason = '讀不到條碼下方的文字'; return; }

  if (!r.ocr2) {
    r.verdict = 'CHECK';
    r.reason = '第二次 OCR 讀不到文字，無法完成雙次核對';
    return;
  }
  if (r.pdfText != null && r.pdfText !== tx) {
    // 文字層不能代替實際印字（隱藏文字、被蓋住的文字都會被抽出來），
    // 但兩者對不起來本身就是警訊。
    r.verdict = 'CHECK';
    r.reason = `PDF 文字層與可見印字辨識不同（${r.pdfText} / ${tx}），請看原圖確認`;
    return;
  }
  if (r.ocr2 !== tx) {
    r.verdict = 'CHECK';
    r.reason = `兩次獨立 OCR 讀出不同結果（${tx} / ${r.ocr2}）`;
    return;
  }
  if (r.tplResConflict && r.tplResConflict.length) {
    r.verdict = 'CHECK';
    r.reason = `模板疊合比對在兩個解析度讀出不同的字（第 ${pos1(r.tplResConflict)} 字：`
      + `${r.dpi}dpi=${r.tplLo}／${r.dpiHi}dpi=${r.tplHi}），請看原圖確認`;
    r.textConflict = true;
    return;
  }
  const sh = r.shape || '', tp = r.tpl || '';
  for (const [name, value] of [['字形覆核', sh], ['模板疊合比對', tp]]) {
    const conflict = [...value].some((c, i) => c !== '?' && (i >= tx.length || c !== tx[i]));
    if (value.includes('?') && conflict) {
      r.verdict = 'CHECK';
      r.reason = `文字辨識有衝突——${name}=${value}；部分字雖未辨識，已確認的衝突仍須人工核對`;
      r.textConflict = true;
      return;
    }
  }
  const shOk = !!sh && !sh.includes('?');
  const tpOk = !!tp && !tp.includes('?');
  const tracks = [['OCR×2', tx]];
  if (shOk) tracks.push(['字形覆核', sh]);
  if (tpOk) tracks.push(['模板疊合比對', tp]);       // 這條完全不經 OCR

  if (new Set(tracks.map(t => t[1])).size > 1) {     // 有軌互相矛盾
    r.verdict = 'CHECK';
    r.reason = '文字辨識有衝突——' + tracks.map(([n, v]) => `${n}=${v}`).join('、') + '，實際印字待人工確認';
    r.textConflict = true;
    return;
  }
  if (tracks.length < 2) {                           // 證據只有一條
    r.verdict = 'CHECK';
    r.reason = `只有單軌 OCR：字形覆核不可用（${sh ? '字數或票數不足' : '沒切出字形'}），也沒有模板疊合比對可佐證`;
    return;
  }
  if (r.score < MIN_SCORE && !tpOk) {                // 信心低又沒有不經 OCR 的佐證
    r.verdict = 'CHECK';
    r.reason = `OCR 信心 ${r.score.toFixed(2)} 低於門檻 ${MIN_SCORE.toFixed(2)}，且沒有不經 OCR 的證據可佐證`;
    return;
  }
  if (!tpOk) {
    const miss = [...tp].map((c, i) => c === '?' ? i : -1).filter(i => i >= 0);
    r.verdict = 'CHECK';
    r.reason = miss.length
      ? `模板疊合比對第 ${pos1(miss)} 字辨識不出（${r.dpi}dpi 與 ${r.dpiHi}dpi 都試過）；`
        + '字形覆核票源仍是 OCR，不能當作獨立佐證'
      : '模板疊合比對未完整辨識；字形覆核票源仍是 OCR，不能當作獨立佐證';
    return;
  }
  r.verdict = tx === bc ? 'OK' : 'NG';
  const low = r.score < MIN_SCORE
    ? `；OCR 信心 ${r.score.toFixed(2)} 偏低，但有不經 OCR 的模板疊合比對佐證` : '';
  // NG 這句要講清楚「一致的是三條軌彼此」，不是「跟條碼一致」——
  // 否則 NG 的列上寫著「全部一致」，一眼掃過去會誤以為沒事。
  r.reason = tracks.map(t => t[0]).join('＋')
    + (r.verdict === 'OK' ? ' 全部一致' : ' 讀出的印字一致，但與條碼不符') + low;
}

/** 疊合比對的結果寫成人看得懂的一句話（判定本身已在 finalize 用掉這條證據）。 */
export function tplNote(r) {
  const tp = r.tpl || '';
  if (!tp) return null;
  if (tp.includes('?'))
    return { text: `疊合比對有 ${[...tp].filter(c => c === '?').length} 個字形狀分不出來，這幾個字沒被覆核到`, weak: true };
  const mg = r.tplMargin || 0;
  const ratio = mg / TPL_MIN_MARGIN;
  if (r.tplBad && r.tplBad.length)
    return { text: `疊合比對發現第 ${pos1(r.tplBad)} 字的形狀與條碼不符`, weak: false, bad: true };
  return {
    text: `疊合比對：${tp.length} 個字形狀全部吻合條碼（最小把握度 ${mg.toFixed(3)}，`
      + `是門檻的 ${ratio.toFixed(1)} 倍——倍數越大越有把握）`,
    weak: ratio < 1.5
  };
}
