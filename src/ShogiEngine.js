// ---- USI 座標変換 ----
const KIND_TO_USI = { FU: 'P', KY: 'L', KE: 'N', GI: 'S', KI: 'G', KA: 'B', HI: 'R' };
const USI_TO_KIND = { P: 'FU', L: 'KY', N: 'KE', S: 'GI', G: 'KI', B: 'KA', R: 'HI' };

function rankToChar(y) {
  return String.fromCharCode(96 + y); // 1→'a', 9→'i'
}

function charToRank(c) {
  return c.charCodeAt(0) - 96;
}

export function moveToUSI(mv) {
  if (mv.type === 'drop') {
    return `${KIND_TO_USI[mv.kind]}*${mv.tox}${rankToChar(mv.toy)}`;
  }
  return `${mv.fromx}${rankToChar(mv.fromy)}${mv.tox}${rankToChar(mv.toy)}${mv.promote ? '+' : ''}`;
}

export function usiToMoveInfo(usiMove) {
  if (!usiMove || usiMove === 'resign' || usiMove === 'win') return null;
  if (usiMove[1] === '*') {
    return {
      type: 'drop',
      kind: USI_TO_KIND[usiMove[0]] ?? null,
      tox: parseInt(usiMove[2]),
      toy: charToRank(usiMove[3]),
    };
  }
  return {
    type: 'move',
    fromx: parseInt(usiMove[0]),
    fromy: charToRank(usiMove[1]),
    tox: parseInt(usiMove[2]),
    toy: charToRank(usiMove[3]),
    promote: usiMove.length > 4 && usiMove[4] === '+',
  };
}

export function toUSIPosition(moveHistory) {
  if (!moveHistory || moveHistory.length === 0) return 'position startpos';
  return `position startpos moves ${moveHistory.map(moveToUSI).join(' ')}`;
}

// ---- エンジン管理 ----
let engineInstance = null;
let initPromise = null;

// 優先度つきジョブスケジューラ。Worker への go は常に1つずつ直列実行する。
//   high = 対話的解析（ノード選択）… 最新のみ有効・実行中を横取り
//   low  = バッチ解析（自動棋譜解析）… high に譲り、横取りされたら再投入
let jobSeq = 0;
let queue = [];       // 待機ジョブ
let running = null;   // 実行中の制御 { job, requeue, discardResult }
let pumping = false;

const waitMap = {};
const respMap = {};

function markWait(key, gatherKeys = []) {
  waitMap[key] = true;
  for (const k of gatherKeys) respMap[k] = '';
}

function waitFor(key) {
  return new Promise(resolve => {
    const tick = () => {
      if (waitMap[key]) {
        setTimeout(tick, 5);
      } else {
        delete waitMap[key];
        resolve(respMap[key] ?? '');
      }
    };
    tick();
  });
}

function onLine(line) {
  console.debug('[engine]', line);
  for (const key of Object.keys(respMap)) {
    if (line.startsWith(key)) respMap[key] = line;
  }
  for (const key of Object.keys(waitMap)) {
    if (waitMap[key] && line.startsWith(key)) {
      respMap[key] = line;
      waitMap[key] = false;
    }
  }
}

async function initEngine() {
  console.log('[engine] 初期化開始');
  const mod = await import('@mizarjp/yaneuraou.k-p');
  const YaneuraOu = mod.default ?? mod;

  const eng = await YaneuraOu({
    // wasm / worker.js は public/ から未変換で配信されるファイルを参照する
    locateFile: (filename) => `/yaneuraou/${filename}`,
    // Worker 内の importScripts(urlOrBlob) に渡すメインスクリプトURL。
    // ESM バンドル環境では document.currentScript が null になり内部で
    // urlOrBlob=undefined → URL.createObjectURL(undefined) がクラッシュするため明示指定する。
    mainScriptUrlOrBlob: '/yaneuraou/yaneuraou.k-p.js',
    printErr: (msg) => console.warn('[engine stderr]', msg),
  });

  eng.addMessageListener(onLine);

  markWait('usiok');
  eng.postMessage('usi');
  await waitFor('usiok');
  console.log('[engine] usiok 受信');

  eng.postMessage('setoption name USI_Hash value 256');
  eng.postMessage('setoption name PvInterval value 0');
  eng.postMessage('setoption name Threads value 2');
  eng.postMessage('setoption name MultiPV value 3'); // 上位3候補手

  markWait('readyok');
  eng.postMessage('isready');
  await waitFor('readyok');
  console.log('[engine] readyok 受信 — 準備完了');

  engineInstance = eng;
  return eng;
}

export function getEngine() {
  if (!initPromise) initPromise = initEngine();
  return initPromise;
}

export function isEngineReady() {
  return engineInstance !== null;
}

function stopEngine() {
  if (engineInstance) engineInstance.postMessage('stop');
}

/** ジョブを投入し、優先度に応じてキュー整列・横取りを行う */
function schedule(job) {
  if (job.priority === 'high') {
    // 対話解析は「最新のみ有効」：保留中の high は破棄
    for (const j of queue) {
      if (j.priority === 'high') { j.discarded = true; j.resolve(null); }
    }
    queue = queue.filter(j => j.priority !== 'high');
    queue.unshift(job); // high を先頭へ
    if (running) {
      if (running.job.priority === 'low') running.requeue = true;   // バッチは後で再投入
      else running.discardResult = true;                            // 古い high は破棄
      stopEngine();                                                 // 実行中を横取り
    }
  } else {
    queue.push(job); // low は末尾
  }
  pump();
}

/** キューを1件ずつ処理（常に go は1つだけ） */
async function pump() {
  if (pumping || running) return;
  const job = queue.shift();
  if (!job) return;
  if (job.discarded) { pump(); return; }

  pumping = true;
  running = { job, requeue: false, discardResult: false };
  try {
    const eng = await getEngine();
    const pos = toUSIPosition(job.moves);
    // 解析対象の局面（盤面との乖離診断用）。違法手が混ざるとエンジンは
    // "Error! : Illegal Input Move" を出して以降の手を無視する。
    console.debug('[engine] position:', pos);
    eng.postMessage(pos);

    // MultiPV: multipv 番号ごとに最新 info を保持
    const latestByPv = {};
    const listener = (line) => {
      if (line.startsWith('info ') && line.includes('score')) {
        const info = parseInfo(line);
        latestByPv[info.multipv] = info;
        if (job.onInfo) job.onInfo(info);
      }
    };
    eng.addMessageListener(listener);

    markWait('bestmove', ['bestmove']);
    eng.postMessage(`go movetime ${job.thinkMs}`);
    const bestmoveLine = await waitFor('bestmove');
    eng.removeMessageListener(listener);

    const cur = running;
    running = null;
    pumping = false;

    if (cur.requeue && !job.discarded) {
      queue.push(job); // バッチが横取りされた → 後回しで再実行
    } else if (cur.discardResult || job.discarded) {
      job.resolve(null);
    } else {
      job.resolve(buildResult(bestmoveLine, latestByPv));
    }
    pump();
  } catch (err) {
    running = null;
    pumping = false;
    console.error('解析エラー:', err);
    job.resolve(null);
    pump();
  }
}

/** 対話的解析（高優先・最新のみ有効・実行中を横取り） */
export function analyze(moveHistory, thinkMs = 1500, onInfo = null) {
  return new Promise(resolve => schedule({
    id: ++jobSeq, moves: moveHistory, thinkMs, onInfo,
    priority: 'high', resolve, discarded: false,
  }));
}

/** バッチ解析（低優先・high に譲る・横取りされたら再投入） */
export function analyzeLow(moveHistory, thinkMs = 1500, onInfo = null) {
  return new Promise(resolve => schedule({
    id: ++jobSeq, moves: moveHistory, thinkMs, onInfo,
    priority: 'low', resolve, discarded: false,
  }));
}

/** 対話的解析（high）のみ中断。バッチ（low）は継続させる。 */
export function stopAnalysis() {
  for (const j of queue) {
    if (j.priority === 'high') { j.discarded = true; j.resolve(null); }
  }
  queue = queue.filter(j => j.priority !== 'high');
  if (running && running.job.priority === 'high') {
    running.discardResult = true;
    stopEngine();
  }
}

/** バッチ解析（low）を全キャンセル。 */
export function cancelBatch() {
  for (const j of queue) {
    if (j.priority === 'low') { j.discarded = true; j.resolve(null); }
  }
  queue = queue.filter(j => j.priority !== 'low');
  if (running && running.job.priority === 'low') {
    running.requeue = false;
    running.discardResult = true;
    stopEngine();
  }
}

/**
 * 手番側視点のスコアを先手視点に正規化する（cp・mate 共通）。
 * mate も cp と同様に手番側視点だが、mate 0 は「手番側が既に詰んでいる」
 * の意味で符号を持たないため、手番から負け側を決める。
 * 実測: 詰まされた局面でエンジンは「score mate -0」を返し parseInt で符号が消える。
 * @param {number|null} score  エンジンの生スコア
 * @param {boolean} isMate     mate スコアか
 * @param {0|1} turn           解析局面の手番（0=先手番 1=後手番）
 * @returns {number|null}      先手視点のスコア（正=先手有利）
 */
export function toBlackScore(score, isMate, turn) {
  if (score === null || score === undefined) return null;
  if (isMate && score === 0) return turn === 0 ? -1 : 1; // 手番側の負け
  return turn === 0 ? score : -score;
}

// ---- パーサ ----
function parseInfo(line) {
  const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
  const depthMatch = line.match(/\bdepth (\d+)/);
  const pvMatch = line.match(/\bpv (.+)/);
  const mpvMatch = line.match(/\bmultipv (\d+)/);
  let score = null;
  let isMate = false;
  if (scoreMatch) {
    isMate = scoreMatch[1] === 'mate';
    score = parseInt(scoreMatch[2]);
  }
  const pv = pvMatch ? pvMatch[1].trim().split(/\s+/) : [];
  return {
    score,
    isMate,
    depth: depthMatch ? parseInt(depthMatch[1]) : null,
    multipv: mpvMatch ? parseInt(mpvMatch[1]) : 1,
    pv,
    moveUSI: pv[0] ?? null,
  };
}

// bestmove 行 ＋ multipv 別の最新 info から結果を組み立てる。
// score/isMate/depth/pv は multipv=1（主候補）… 評価値キャッシュ用。
// candidates は上位3候補。
function buildResult(bestmoveLine, latestByPv) {
  const parts = (bestmoveLine ?? '').split(' ');
  const rawMove = parts[1];
  const move = rawMove && rawMove !== 'resign' && rawMove !== 'win' ? rawMove : null;
  const primary = latestByPv[1] ?? {};
  const candidates = [1, 2, 3]
    .map(i => latestByPv[i])
    .filter(Boolean)
    .map(c => ({
      multipv: c.multipv, score: c.score, isMate: c.isMate,
      depth: c.depth, pv: c.pv, moveUSI: c.moveUSI,
    }));
  return {
    move,
    score: primary.score ?? null,
    isMate: primary.isMate ?? false,
    depth: primary.depth ?? null,
    pv: primary.pv ?? [],
    candidates,
  };
}
