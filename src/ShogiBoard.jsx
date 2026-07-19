import { useRef, useState, useEffect } from 'react';
import { Shogi, Piece } from 'shogi.js';
import { analyze, stopAnalysis, usiToMoveInfo, toBlackScore } from './ShogiEngine.js';
import { leavesKingInCheck } from './legality.js';

const KIND_KANJI = {
  FU: '歩', KY: '香', KE: '桂', GI: '銀', KI: '金', KA: '角', HI: '飛', OU: '玉',
  TO: 'と', NY: '杏', NK: '圭', NG: '全', UM: '馬', RY: '龍',
};
const PROMOTED_KINDS = new Set(['TO', 'NY', 'NK', 'NG', 'UM', 'RY']);
const ROW_KANJI = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const HAND_KINDS = ['HI', 'KA', 'KI', 'GI', 'KE', 'KY', 'FU'];
const CELL = 54;
const INIT_EVAL = { isAnalyzing: false, score: null, blackScore: null, depth: null, isMate: false, pv: [] };

// ---- 盤面反転（表示層のみの座標変換） ----
// 論理座標（x=筋1〜9・y=段1〜9）と画面上の位置の対応を切り替える。
// flipped=false は恒等変換、true は180度回転（10-x, 10-y）。
// 自分自身が逆変換になる（2回適用で元に戻る）ため、
// 描画（論理→表示）とクリック（表示→論理）の両方をこの1関数で賄える。
// ※export しない：コンポーネント以外の export は Fast Refresh を壊す（react-refresh lint）
function flipView(x, y, flipped) {
  return flipped ? { x: 10 - x, y: 10 - y } : { x, y };
}

// ---- SVG 将棋駒（木製駒・二文字表記） ----
// 五角形パス（viewBox 0 0 100 120、右下に影用の余白）
const KOMA_OUTER = '49,10 85,32 94,112 4,112 13,32';
const KOMA_INNER = '49,16 81,35 89,106 9,106 17,35';

const KOMA_FONT = "'Hiragino Mincho ProN', 'Yu Mincho', serif";

// 駒種 → 二文字表記（縦積み）。1要素なら1文字を大きく表示。
const KOMA_LABEL = {
  FU: ['歩', '兵'], KY: ['香', '車'], KE: ['桂', '馬'], GI: ['銀', '将'],
  KI: ['金', '将'], KA: ['角', '行'], HI: ['飛', '車'], OU: ['玉', '将'],
  TO: ['と'], // 成歩は「と」1文字を大きく
  NY: ['成', '香'], NK: ['成', '桂'], NG: ['成', '銀'],
  UM: ['竜', '馬'], RY: ['竜', '王'],
};

/**
 * 木製駒 1 枚を描画する共通コンポーネント。
 * @param kind  shogi.js の駒種コード
 * @param isWhite 後手なら group ごと 180 度回転（文字も反転＝本物と同じ）
 * @param px  レンダリング幅(px)
 */
function Koma({ kind, isWhite, px }) {
  const isPromoted = PROMOTED_KINDS.has(kind);
  const label = KOMA_LABEL[kind] ?? [KIND_KANJI[kind] ?? kind];
  const textColor = isPromoted ? '#B3231A' : '#1B120A';

  // 文字レイアウト：2文字は縦に積む、1文字は中央に大きく
  const chars =
    label.length === 2 ? (
      <>
        <text
          x="49" y="52" textAnchor="middle" dominantBaseline="central"
          fontFamily={KOMA_FONT} fontWeight="bold" fontSize="34" fill={textColor}
        >{label[0]}</text>
        <text
          x="49" y="87" textAnchor="middle" dominantBaseline="central"
          fontFamily={KOMA_FONT} fontWeight="bold" fontSize="34" fill={textColor}
        >{label[1]}</text>
      </>
    ) : (
      <text
        x="49" y="66" textAnchor="middle" dominantBaseline="central"
        fontFamily={KOMA_FONT} fontWeight="bold" fontSize="56" fill={textColor}
      >{label[0]}</text>
    );

  return (
    <svg
      width={px}
      height={px * 1.2}
      viewBox="0 0 100 120"
      style={{ display: 'block', pointerEvents: 'none', userSelect: 'none', overflow: 'visible' }}
    >
      <defs>
        {/* 木目グラデーション（全駒共有） */}
        <linearGradient id="komaWood" x1="0" y1="0" x2="0.15" y2="1">
          <stop offset="0%" stopColor="#F2DCA8" />
          <stop offset="45%" stopColor="#E5C285" />
          <stop offset="100%" stopColor="#C99B5A" />
        </linearGradient>
        <clipPath id="komaClip">
          <polygon points={KOMA_OUTER} />
        </clipPath>
      </defs>

      <g transform={isWhite ? 'rotate(180 49 61)' : undefined}>
        {/* 影：同じ五角形を右下にずらして背面に */}
        <polygon points={KOMA_OUTER} fill="#000" opacity="0.13" transform="translate(4.5,4.5)" />

        {/* 本体＋外周の輪郭 */}
        <polygon
          points={KOMA_OUTER}
          fill="url(#komaWood)"
          stroke="#5C3A1E"
          strokeWidth="2"
          strokeLinejoin="round"
        />

        {/* 木目：縦方向の Q カーブ */}
        <g clipPath="url(#komaClip)">
          <path d="M40,24 Q33,64 42,108" fill="none" stroke="#A97F45" strokeWidth="0.8" opacity="0.3" />
          <path d="M60,24 Q67,64 58,108" fill="none" stroke="#A97F45" strokeWidth="0.8" opacity="0.3" />
        </g>

        {/* 内側の二重線 */}
        <polygon
          points={KOMA_INNER}
          fill="none"
          stroke="#8A5A2B"
          strokeWidth="0.7"
          strokeLinejoin="round"
          opacity="0.55"
        />

        {/* 文字 */}
        {chars}
      </g>
    </svg>
  );
}

// 盤上・ダイアログ用。flipped 時は向きが逆転する（後手が正向き）
function ShogiPieceSVG({ kind, color, size = CELL - 3, flipped = false }) {
  return <Koma kind={kind} isWhite={(color === 1) !== flipped} px={size} />;
}

// 持ち駒用（縮小版）。flipped 時は向きが逆転する
function HandPieceSVG({ kind, color, flipped = false }) {
  return <Koma kind={kind} isWhite={(color === 1) !== flipped} px={34} />;
}

function createShogi(moveHistory) {
  const s = new Shogi();
  s.initialize({ preset: 'HIRATE' });
  for (const mv of moveHistory ?? []) {
    try {
      if (mv.type === 'move') s.move(mv.fromx, mv.fromy, mv.tox, mv.toy, mv.promote);
      else if (mv.type === 'drop') s.drop(mv.tox, mv.toy, mv.kind, mv.color);
    } catch (e) {
      console.error('手順再生エラー:', e);
      break;
    }
  }
  return s;
}

function inPromZone(y, color) {
  return color === 0 ? y <= 3 : y >= 7;
}

function mustPromote(kind, toy, color) {
  if ((kind === 'FU' || kind === 'KY') && (color === 0 ? toy === 1 : toy === 9)) return true;
  if (kind === 'KE' && (color === 0 ? toy <= 2 : toy >= 8)) return true;
  return false;
}

function toKifText(kind, tox, toy, promote, isDrop) {
  return `${tox}${ROW_KANJI[toy]}${KIND_KANJI[kind] ?? kind}${isDrop ? '打' : promote ? '成' : ''}`;
}

// ワイドモード（ツリーOFF・広画面）のサイドバー幅
const SIDEBAR_W = 360;
const SIDEBAR_INNER = SIDEBAR_W - 24; // padding 12×2 を除いた内寸

export default function ShogiBoard({
  moveHistory, onMove, boardKey, nav, onEval, blunder,
  wide = false, graphSlot = null, mobile = false,
}) {
  const shogiRef = useRef(null);
  const [, setTick] = useState(0);
  const [selected, setSelected] = useState(null);
  const [legalMoves, setLegalMoves] = useState([]);
  const [pendingProm, setPendingProm] = useState(null);
  const [evalInfo, setEvalInfo] = useState(INIT_EVAL);
  const [bestMove, setBestMove] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [hoverMove, setHoverMove] = useState(null);
  const [flipped, setFlipped] = useState(() => localStorage.getItem('shogi-flip-board') === '1');
  useEffect(() => { localStorage.setItem('shogi-flip-board', flipped ? '1' : '0'); }, [flipped]);

  if (!shogiRef.current) {
    shogiRef.current = createShogi(moveHistory);
  }

  // ノード切り替え時に盤面を再構築して解析を開始
  useEffect(() => {
    shogiRef.current = createShogi(moveHistory);
    setSelected(null);
    setLegalMoves([]);
    setPendingProm(null);
    setTick(n => n + 1);
    setEvalInfo({ ...INIT_EVAL, isAnalyzing: true });
    setBestMove(null);
    // candidates は消さない：解析完了まで前回の候補手を薄く表示し続ける
    // （パネル高さを固定してレイアウトシフトを防ぐ）
    setHoverMove(null);

    const turn = shogiRef.current.turn; // 0=先手 1=後手
    let cancelled = false;

    analyze(
      moveHistory,
      1500,
      (info) => {
        if (cancelled) return;
        // 評価値バーには multipv=1（主候補）のみ反映
        if (info.multipv && info.multipv !== 1) return;
        const bs = toBlackScore(info.score, info.isMate, turn);
        setEvalInfo(prev => ({ ...prev, ...info, blackScore: bs, isAnalyzing: true }));
      },
    ).then(result => {
      if (cancelled || !result) return;
      const bs = toBlackScore(result.score, result.isMate, turn);
      setEvalInfo({ ...result, blackScore: bs, isAnalyzing: false });
      setBestMove(result.move ? usiToMoveInfo(result.move) : null);
      setCandidates(result.candidates ?? []);
      // 既存の解析結果をノードへ通知（先手視点・詰みは番兵値）。エンジン呼び出しは増やさない。
      // pv（multipv=1 の読み筋）は最善手ブランチ生成用に先頭7手まで保存する。
      if (onEval && bs !== null) {
        const cp = result.isMate ? (bs > 0 ? 99999 : -99999) : bs;
        onEval(boardKey, {
          cp, depth: result.depth ?? 0, isMate: !!result.isMate,
          pv: (result.pv ?? []).slice(0, 7),
        });
      }
    }).catch(err => {
      if (!cancelled) {
        console.error('解析エラー:', err);
        setEvalInfo(INIT_EVAL);
      }
    });

    return () => {
      cancelled = true;
      stopAnalysis();
    };
  }, [boardKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const shogi = shogiRef.current;

  function doMove(fromx, fromy, tox, toy, promote) {
    const piece = shogi.get(fromx, fromy);
    const kifText = toKifText(piece.kind, tox, toy, promote, false);
    shogi.move(fromx, fromy, tox, toy, promote);
    setSelected(null);
    setLegalMoves([]);
    setTick(n => n + 1);
    onMove({ type: 'move', fromx, fromy, tox, toy, promote }, kifText);
  }

  function doDrop(tox, toy, kind, color) {
    const kifText = toKifText(kind, tox, toy, false, true);
    shogi.drop(tox, toy, kind, color);
    setSelected(null);
    setLegalMoves([]);
    setTick(n => n + 1);
    onMove({ type: 'drop', tox, toy, kind, color }, kifText);
  }

  // 候補手をクリック → その手を現在ノードの子として指す（重複は App 側で吸収）
  function playCandidate(cand) {
    const mv = usiToMoveInfo(cand.moveUSI);
    if (!mv) return;
    setHoverMove(null);
    if (mv.type === 'drop') doDrop(mv.tox, mv.toy, mv.kind, shogi.turn);
    else doMove(mv.fromx, mv.fromy, mv.tox, mv.toy, mv.promote);
  }

  function handleCellClick(x, y) {
    const isTarget = legalMoves.some(m => m.to.x === x && m.to.y === y);

    if (selected && isTarget) {
      if (selected.type === 'hand') {
        doDrop(x, y, selected.kind, shogi.turn);
        return;
      }
      const fromPiece = shogi.get(selected.x, selected.y);
      const canProm =
        Piece.canPromote(fromPiece.kind) &&
        (inPromZone(y, fromPiece.color) || inPromZone(selected.y, fromPiece.color));
      const must = mustPromote(fromPiece.kind, y, fromPiece.color);
      if (must) {
        doMove(selected.x, selected.y, x, y, true);
      } else if (canProm) {
        setPendingProm({ fromx: selected.x, fromy: selected.y, tox: x, toy: y, kind: fromPiece.kind });
        setSelected(null);
        setLegalMoves([]);
      } else {
        doMove(selected.x, selected.y, x, y, false);
      }
      return;
    }

    const piece = shogi.get(x, y);
    if (piece && piece.color === shogi.turn) {
      setSelected({ type: 'board', x, y });
      // 疑似合法手から王手放置（自玉が取られる手）を除外する。
      // エンジンはこれらを黙って無視するため、許すと盤とエンジンの局面が乖離する。
      setLegalMoves(shogi.getMovesFrom(x, y).filter(m => !leavesKingInCheck(moveHistory, {
        type: 'move', fromx: x, fromy: y, tox: m.to.x, toy: m.to.y,
        promote: mustPromote(piece.kind, m.to.y, piece.color),
      })));
    } else {
      setSelected(null);
      setLegalMoves([]);
    }
  }

  function handleHandClick(kind, color) {
    if (color !== shogi.turn) return;
    // 王手放置になる打ち場所を除外（盤上の移動と同じ理由）
    const drops = shogi.getDropsBy(color)
      .filter(m => m.kind === kind)
      .filter(m => !leavesKingInCheck(moveHistory, {
        type: 'drop', tox: m.to.x, toy: m.to.y, kind,
      }));
    if (drops.length === 0) return;
    setSelected({ type: 'hand', kind, color });
    setLegalMoves(drops);
  }

  const blackHands = shogi.getHandsSummary(0);
  const whiteHands = shogi.getHandsSummary(1);

  // 持ち駒は盤の左右に配置：奥側（相手）=左、手前側（自分）=右。
  // 反転時は左右を入れ替える（常に手前側が右）。表示のみの変換。
  const handLeft = flipped
    ? { label: '▲ 先手', hands: blackHands, color: 0 }
    : { label: '△ 後手', hands: whiteHands, color: 1 };
  const handRight = flipped
    ? { label: '△ 後手', hands: whiteHands, color: 1 }
    : { label: '▲ 先手', hands: blackHands, color: 0 };
  const colLabels = flipped ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [9, 8, 7, 6, 5, 4, 3, 2, 1];
  const rowLabels = flipped ? ROW_KANJI.slice(1).reverse() : ROW_KANJI.slice(1);

  // ---- ワイドモード：盤面ブロックの拡大率をメイン領域の実測サイズから計算 ----
  // transform: scale はレイアウト専用の変換で、クリックのヒットテストや
  // マス内バッジの相対位置はブラウザが変換ごと扱うため座標ロジックは無変更。
  const coreRef = useRef(null);   // 拡大対象（持ち駒＋盤面の行）
  const mainRef = useRef(null);   // メイン領域（利用可能サイズの計測元）
  const [scale, setScale] = useState(1);
  const [coreBase, setCoreBase] = useState(null); // 拡大前の実寸
  useEffect(() => {
    if (!wide) { setScale(1); return; }
    const compute = () => {
      const core = coreRef.current;
      const mainEl = mainRef.current;
      if (!core || !mainEl) return;
      const bw = core.offsetWidth;   // offsetWidth は transform の影響を受けない
      const bh = core.offsetHeight;
      const rect = mainEl.getBoundingClientRect();
      const availW = rect.width - 40;
      const availH = rect.height - 100; // ナビバー・余白ぶんを確保
      if (bw <= 0 || bh <= 0 || availW <= 0 || availH <= 0) return;
      const maxByBoard = 900 / (CELL * 9); // 盤の一辺 ≤ 900px
      setScale(Math.max(0.5, Math.min(availW / bw, availH / bh, maxByBoard)));
      setCoreBase({ w: bw, h: bh });
    };
    compute();
    const ro = new ResizeObserver(compute);
    if (mainRef.current) ro.observe(mainRef.current);
    return () => ro.disconnect();
  }, [wide]);

  // ---- モバイル（768px未満）：盤面ブロックを画面幅に収まるよう縮小 ----
  // ワイドモードと同じ transform: scale 方式（クリック座標はブラウザが変換ごと扱う）。
  const mobileCoreRef = useRef(null);
  const [mobileScale, setMobileScale] = useState(1);
  const [mobileBase, setMobileBase] = useState(null);
  useEffect(() => {
    if (!mobile) { setMobileScale(1); setMobileBase(null); return; }
    const compute = () => {
      const el = mobileCoreRef.current;
      if (!el) return;
      const w = el.offsetWidth;   // transform の影響を受けない実寸
      const h = el.offsetHeight;
      if (w <= 0) return;
      const avail = window.innerWidth - 24; // 左右 padding ぶん
      // 画面幅いっぱいまで拡大（上限はワイドモードと同じ盤の一辺 900px）
      setMobileScale(Math.min(avail / w, 900 / (CELL * 9)));
      setMobileBase({ w, h });
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [mobile]);

  // 評価値バー（手番表示を含む）と候補手パネル：
  // ワイド時はサイドバー幅、モバイル時は画面幅内に収める
  const panelW = wide
    ? SIDEBAR_INNER
    : mobile
    ? `min(${CELL * 9}px, calc(100vw - 24px))`
    : CELL * 9;
  const evalBarEl = <EvalBar evalInfo={evalInfo} turn={shogi.turn} width={panelW} />;
  const candidateEl = (
    <CandidatePanel
      candidates={candidates}
      isAnalyzing={evalInfo.isAnalyzing}
      shogi={shogi}
      onHover={setHoverMove}
      onPick={playCandidate}
      width={panelW}
    />
  );

  // 候補手が駒打ちのとき、手番側の駒台の該当駒種をハイライトする
  // （盤面の hoverMove ハイライトと同じ state を参照するため完全に同期する）
  const hoverDropKind = hoverMove?.type === 'drop' ? hoverMove.kind : null;
  // 常時プレビュー（最善手・盤の青丸マーカーと同じ bestMove state）が駒打ちの場合の駒種
  const bestDropKind = bestMove?.type === 'drop' ? bestMove.kind : null;
  // 駒台に渡す駒種：ホバー操作中はホバーを優先（経路(1)の挙動は不変）、
  // 無操作時は最善手プレビューの駒打ちを表示（経路(2)への追加）
  const standDropKind = hoverMove ? hoverDropKind : bestDropKind;

  // 相手側（奥）＝handLeft、自分側（手前）＝handRight（反転時は定義側で入れ替わる）
  const handOppEl = (
    <HandArea
      label={handLeft.label}
      hands={handLeft.hands}
      color={handLeft.color}
      flipped={flipped}
      selected={selected}
      onHandClick={handleHandClick}
      hoverKind={handLeft.color === shogi.turn ? standDropKind : null}
      horizontal={mobile}
    />
  );
  const handMineEl = (
    <HandArea
      label={handRight.label}
      hands={handRight.hands}
      color={handRight.color}
      flipped={flipped}
      selected={selected}
      onHandClick={handleHandClick}
      hoverKind={handRight.color === shogi.turn ? standDropKind : null}
      horizontal={mobile}
    />
  );

  // 段・筋ラベルの幅：モバイルでは余白を詰めて盤を大きくする（768px以上は従来どおり）
  const rowLabelW = mobile ? 16 : CELL;

  // 盤面本体（ラベル＋グリッド）
  const boardCore = (
      <div>
        <div style={{ display: 'flex', marginLeft: rowLabelW }}>
          {colLabels.map(c => (
            <div key={c} style={{
              width: CELL, textAlign: 'center', fontSize: 11, color: '#8b5e3c',
              fontFamily: 'serif', lineHeight: `${CELL * 0.4}px`,
            }}>{c}</div>
          ))}
        </div>

        <div style={{ display: 'flex' }}>
          <div>
            {rowLabels.map((r, i) => (
              <div key={i} style={{
                width: rowLabelW, height: CELL,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, color: '#8b5e3c', fontFamily: 'serif',
              }}>{r}</div>
            ))}
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(9, ${CELL}px)`,
            border: '2.5px solid #5c3317',
          }}>
            {Array.from({ length: 81 }, (_, i) => {
              const colIdx = i % 9;
              const rowIdx = Math.floor(i / 9);
              // このマスに表示する論理座標。以降のハイライト判定・クリックは
              // すべてこの x, y を使うので反転時も座標対応が保たれる
              const { x, y } = flipView(9 - colIdx, rowIdx + 1, flipped);
              const piece = shogi.get(x, y);
              const isTarget = legalMoves.some(m => m.to.x === x && m.to.y === y);
              const isSel = selected?.type === 'board' && selected.x === x && selected.y === y;
              const isPromZone = y <= 3 || y >= 7;

              // 候補手ホバーのハイライト（最優先で表示）
              const isHoverFrom =
                hoverMove?.type === 'move' && hoverMove.fromx === x && hoverMove.fromy === y;
              const isHoverTo =
                hoverMove != null && hoverMove.tox === x && hoverMove.toy === y;

              const isBestFrom =
                !isSel && !isTarget && !isHoverFrom && !isHoverTo &&
                bestMove?.type === 'move' && bestMove.fromx === x && bestMove.fromy === y;
              const isBestTo =
                !isSel && !isTarget && !isHoverFrom && !isHoverTo &&
                bestMove != null && bestMove.tox === x && bestMove.toy === y;

              const bg = isSel
                ? '#f0c060'
                : isTarget
                ? 'rgba(60,180,60,0.35)'
                : isHoverFrom
                ? 'rgba(140,60,200,0.22)'
                : isHoverTo
                ? 'rgba(140,60,200,0.32)'
                : isBestFrom
                ? 'rgba(50,110,230,0.18)'
                : isBestTo
                ? 'rgba(50,110,230,0.10)'
                : isPromZone
                ? 'rgba(205,170,110,0.5)'
                : 'rgba(222,184,135,0.3)';

              return (
                <div
                  key={i}
                  onClick={() => handleCellClick(x, y)}
                  style={{
                    width: CELL, height: CELL,
                    border: '1px solid #c8a96e',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', boxSizing: 'border-box',
                    background: bg, position: 'relative',
                    transition: 'background 0.08s',
                  }}
                >
                  {(isBestFrom || isBestTo) && (
                    <div style={{
                      position: 'absolute', inset: 1,
                      border: `2px solid rgba(50,110,230,${isBestFrom ? 0.6 : 0.4})`,
                      borderRadius: 2,
                      pointerEvents: 'none',
                    }} />
                  )}
                  {(isHoverFrom || isHoverTo) && (
                    <div style={{
                      position: 'absolute', inset: 1,
                      border: `2.5px solid rgba(140,60,200,${isHoverTo ? 0.85 : 0.6})`,
                      borderRadius: 2,
                      pointerEvents: 'none',
                    }} />
                  )}

                  {piece && (
                    <ShogiPieceSVG kind={piece.kind} color={piece.color} flipped={flipped} />
                  )}

                  {isTarget && !piece && (
                    <div style={{
                      width: 14, height: 14, borderRadius: '50%',
                      background: 'rgba(40,160,40,0.6)',
                      pointerEvents: 'none',
                    }} />
                  )}
                  {isBestTo && !piece && !isTarget && (
                    <div style={{
                      width: 12, height: 12, borderRadius: '50%',
                      background: 'rgba(50,110,230,0.45)',
                      pointerEvents: 'none',
                    }} />
                  )}

                  {/* 疑問手バッジ（選択ノードの指し手の移動先マス・右上） */}
                  {blunder && blunder.tox === x && blunder.toy === y && (
                    <div style={{
                      position: 'absolute', top: 1, right: 1, zIndex: 2,
                      minWidth: 15, height: 15, padding: '0 3px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: blunder.mark === '??' ? '#d32f2f' : '#ef8c1a',
                      color: '#fff', fontSize: 10, fontWeight: 'bold', lineHeight: 1,
                      borderRadius: 8, border: '1px solid #fff',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.35)',
                      pointerEvents: 'none',
                    }}>
                      {blunder.mark}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
  );

  // モバイル：持ち駒を盤の上下に配置（上=相手側・下=手前側。反転時は handLeft/handRight の
  // 定義側で色が入れ替わるため「手前側が常に下」が保たれる）。
  // デスクトップ：従来どおり左右配置。
  const boardRow = mobile ? (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        {handOppEl}
        {boardCore}
        {handMineEl}
      </div>
  ) : (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        {handOppEl}
        {boardCore}
        {handMineEl}
      </div>
  );

  // ナビゲーションバー（盤面反転トグルを含む）
  const navEl = nav
    ? <NavBar nav={nav} flipped={flipped} onFlip={() => setFlipped(f => !f)} />
    : null;

  // 成り確認ダイアログ（position:fixed のため両レイアウト共通）
  const promDialog = pendingProm && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#fdf6e3', border: '2px solid #8b5e3c', borderRadius: 10,
            padding: '24px 32px', textAlign: 'center',
            fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
            boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          }}>
            <div style={{ fontSize: 16, marginBottom: 16, color: '#3a1a00' }}>
              を成りますか？
            </div>
            <div style={{ display: 'flex', gap: 20, justifyContent: 'center', alignItems: 'center', marginBottom: 16 }}>
              <ShogiPieceSVG kind={pendingProm.kind} color={0} size={40} />
              <span style={{ fontSize: 20, color: '#3a1a00' }}>→</span>
              <ShogiPieceSVG kind={Piece.promote(pendingProm.kind)} color={0} size={40} />
            </div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button
                onClick={() => {
                  doMove(pendingProm.fromx, pendingProm.fromy, pendingProm.tox, pendingProm.toy, true);
                  setPendingProm(null);
                }}
                style={promBtnStyle}
              >
                成る
              </button>
              <button
                onClick={() => {
                  doMove(pendingProm.fromx, pendingProm.fromy, pendingProm.tox, pendingProm.toy, false);
                  setPendingProm(null);
                }}
                style={{ ...promBtnStyle, background: '#f0e6d0', color: '#5c3317', border: '1.5px solid #8b5e3c' }}
              >
                成らない
              </button>
            </div>
          </div>
        </div>
  );

  // ---- ワイドモード（ツリーOFF・1200px以上）：左サイドバー＋盤面最大化 ----
  if (wide) {
    return (
      <div style={{ display: 'flex', height: '100%', background: '#f9f3e8' }}>
        {/* 左サイドバー：評価値バー（手番含む）・候補手・グラフ */}
        <div style={{
          width: SIDEBAR_W, flexShrink: 0, overflowY: 'auto',
          borderRight: '2px solid #c8a96e', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', gap: 8, padding: 12,
        }}>
          {evalBarEl}
          {candidateEl}
          {graphSlot && (
            <div style={{
              height: 200, flexShrink: 0, background: '#fff8ec',
              border: '1px solid #c8a96e', borderRadius: 8,
              padding: '5px 8px', boxSizing: 'border-box',
            }}>
              {graphSlot}
            </div>
          )}
        </div>

        {/* メイン領域：盤面を可能な限り大きく（一辺 ≤900px） */}
        <div ref={mainRef} style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{
            margin: 'auto', display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: 8, padding: 12, flexShrink: 0,
          }}>
            {/* scale後の実寸を確保するラッパー（transformはレイアウト寸法を変えないため） */}
            <div style={{
              width: coreBase ? coreBase.w * scale : undefined,
              height: coreBase ? coreBase.h * scale : undefined,
            }}>
              <div
                ref={coreRef}
                style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width: 'fit-content' }}
              >
                {boardRow}
              </div>
            </div>
            {navEl}
          </div>
        </div>

        {promDialog}
      </div>
    );
  }

  // ---- 通常（縦積み）レイアウト：ツリーON時と狭い画面のフォールバック ----
  return (
    <div style={{
      height: '100%', background: '#f9f3e8',
      overflowY: 'auto', overflowX: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* コンテンツラッパー：余白があれば中央寄せ、溢れたら上から縦スクロール */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 8, padding: 12, margin: 'auto', flexShrink: 0,
      }}>
        {evalBarEl}
        {candidateEl}
        {mobile ? (
          /* 縮小後の実寸を確保するラッパー（transformはレイアウト寸法を変えないため） */
          <div style={{
            width: mobileBase ? mobileBase.w * mobileScale : undefined,
            height: mobileBase ? mobileBase.h * mobileScale : undefined,
          }}>
            <div
              ref={mobileCoreRef}
              style={{ transform: `scale(${mobileScale})`, transformOrigin: 'top left', width: 'fit-content' }}
            >
              {boardRow}
            </div>
          </div>
        ) : (
          boardRow
        )}
        {navEl}
      </div>
      {promDialog}
    </div>
  );
}

// ---- 候補手パネル（MultiPV） ----
function candLabel(cand, shogi) {
  const mv = usiToMoveInfo(cand.moveUSI);
  if (!mv) return '—';
  const side = shogi.turn === 0 ? '▲' : '△';
  if (mv.type === 'drop') return side + toKifText(mv.kind, mv.tox, mv.toy, false, true);
  const piece = shogi.get(mv.fromx, mv.fromy);
  return side + toKifText(piece?.kind ?? 'FU', mv.tox, mv.toy, mv.promote, false);
}

function candEvalText(cand, turn) {
  if (cand.score == null) return '—';
  const bs = toBlackScore(cand.score, cand.isMate, turn); // 先手視点
  // 先手視点で正＝先手勝ち＝「後手玉が詰む」
  if (cand.isMate) return bs > 0 ? '後手詰' : '先手詰';
  return (bs >= 0 ? '+' : '') + bs;
}

function pvHead(pv, turn, n = 5) {
  const out = [];
  for (let i = 0; i < Math.min(n, pv.length); i++) {
    const mv = usiToMoveInfo(pv[i]);
    if (!mv) break;
    const side = ((turn + i) % 2 === 0) ? '▲' : '△';
    const suf = mv.type === 'drop' ? '打' : (mv.promote ? '成' : '');
    out.push(`${side}${mv.tox}${ROW_KANJI[mv.toy]}${suf}`);
  }
  return out.join(' ');
}

const CAND_ROW_H = 30;                 // 候補手1行の高さ(px)
const CAND_BODY_H = CAND_ROW_H * 3;    // 本体は常に3行分で固定（レイアウトシフト防止）

function CandidatePanel({ candidates, isAnalyzing, shogi, onHover, onPick, width = CELL * 9 }) {
  const [open, setOpen] = useState(true);
  const firstAnalyzing = isAnalyzing && candidates.length === 0; // 前回結果がない初回
  const stale = isAnalyzing && candidates.length > 0;            // 前回結果を薄く表示中
  console.debug('[候補手] count=', candidates.length, candidates);

  return (
    <div style={{
      width, flexShrink: 0, background: '#f7efdd', border: '1px solid #c8a96e',
      borderRadius: 8, overflow: 'hidden',
      fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '4px 10px', background: '#efe2c4', borderBottom: open ? '1px solid #dcc99a' : 'none',
      }}>
        <span style={{ fontSize: 12, fontWeight: 'bold', color: '#5c3317' }}>
          候補手（上位3）
        </span>
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            fontSize: 11, cursor: 'pointer', border: '1px solid #8b5e3c',
            background: '#fdf6e3', color: '#5c3317', borderRadius: 4, padding: '1px 8px',
            fontFamily: 'inherit',
          }}
        >
          {open ? '隠す' : '表示'}
        </button>
      </div>

      {open && (
        <div style={{ position: 'relative', height: CAND_BODY_H }}>
          {/* 初回のみ：中央に解析中表示 */}
          {firstAnalyzing && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              fontSize: 12, color: '#8b5e3c',
            }}>
              <Spinner /> 解析中...
            </div>
          )}

          {!firstAnalyzing && candidates.length === 0 && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, color: '#b7a888',
            }}>
              候補手なし
            </div>
          )}

          {/* 3行スロット（不足分は空行のまま高さを維持） */}
          <div style={{
            opacity: stale ? 0.4 : 1,
            pointerEvents: stale ? 'none' : 'auto', // 古い候補の誤クリック防止
            transition: 'opacity 0.2s',
          }}>
            {[0, 1, 2].map(i => {
              const c = candidates[i];
              if (!c) {
                return <div key={i} style={{ height: CAND_ROW_H, boxSizing: 'border-box' }} />;
              }
              const mv = usiToMoveInfo(c.moveUSI);
              const bs = c.score == null ? 0 : toBlackScore(c.score, c.isMate, shogi.turn);
              return (
                <div
                  key={i}
                  onMouseEnter={() => onHover(mv)}
                  onMouseLeave={() => onHover(null)}
                  onClick={() => onPick(c)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    height: CAND_ROW_H, boxSizing: 'border-box',
                    padding: '0 10px', cursor: 'pointer',
                    borderBottom: i < 2 ? '1px solid #ece0c4' : 'none',
                    background: i === 0 ? 'rgba(50,110,230,0.06)' : 'transparent',
                  }}
                  onMouseOver={e => (e.currentTarget.style.background = 'rgba(140,60,200,0.10)')}
                  onMouseOut={e => (e.currentTarget.style.background = i === 0 ? 'rgba(50,110,230,0.06)' : 'transparent')}
                >
                  <span style={{
                    fontSize: 10, color: '#fff', background: i === 0 ? '#3a6ee0' : '#a08a5c',
                    borderRadius: 8, minWidth: 16, height: 16, lineHeight: '16px', textAlign: 'center',
                  }}>{i + 1}</span>
                  <span style={{ fontSize: 13, fontWeight: 'bold', color: '#2a1500', minWidth: 60 }}>
                    {candLabel(c, shogi)}
                  </span>
                  <span style={{
                    fontSize: 12, fontWeight: 'bold', minWidth: 46, textAlign: 'right',
                    color: bs > 0 ? '#1a3a1a' : bs < 0 ? '#8b1a1a' : '#555',
                  }}>
                    {candEvalText(c, shogi.turn)}
                  </span>
                  <span style={{
                    fontSize: 10, color: '#8b5e3c', flex: 1, overflow: 'hidden',
                    whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                  }}>
                    {pvHead(c.pv, shogi.turn)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* 前回結果を薄表示中：右上に解析中インジケータ */}
          {stale && (
            <div style={{
              position: 'absolute', top: 4, right: 8,
              display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 10, color: '#8b5e3c',
              background: 'rgba(247,239,221,0.85)', borderRadius: 8, padding: '1px 7px',
              pointerEvents: 'none',
            }}>
              <Spinner /> 解析中...
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- 評価値バー ----
function EvalBar({ evalInfo, turn, width = CELL * 9 }) {
  const { isAnalyzing, blackScore, isMate, depth } = evalInfo;

  let ratio = 0.5;
  if (blackScore !== null) {
    ratio = isMate
      ? (blackScore > 0 ? 0.97 : 0.03)
      : Math.max(0.03, Math.min(0.97, 0.5 + Math.atan(blackScore / 600) / Math.PI));
  }

  const scorePrimary = () => {
    if (blackScore === null) return isAnalyzing ? '解析中...' : '---';
    // 先手視点で正＝先手勝ち＝「後手玉が詰む」（ラベルは詰まされる側）
    if (isMate) return blackScore > 0 ? '後手詰み' : '先手詰み';
    const sign = blackScore >= 0 ? '+' : '';
    return `${sign}${blackScore}`;
  };

  const advantage =
    blackScore === null ? '' :
    isMate ? '' :
    blackScore > 50 ? '先手有利' : blackScore < -50 ? '後手有利' : '互角';

  const depthLabel = depth ? `d${depth}` : '';

  return (
    <div style={{ width, fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif' }}>
      <div style={{
        position: 'relative', height: 48, borderRadius: 8, overflow: 'hidden',
        border: '2px solid #5c3317',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
      }}>
        {/* 後手側（赤）ベース */}
        <div style={{ position: 'absolute', inset: 0, background: '#6b0000' }} />

        {/* 先手側（黒）— ratio幅 */}
        <div style={{
          position: 'absolute', top: 0, left: 0, bottom: 0,
          width: `${ratio * 100}%`,
          background: 'linear-gradient(to right, #111 70%, #2a2a2a 100%)',
          transition: 'width 0.65s cubic-bezier(0.4,0,0.2,1)',
        }} />

        {/* 解析中は半透明オーバーレイ */}
        {isAnalyzing && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(0,0,0,0.25)',
          }} />
        )}

        {/* 中央ライン */}
        <div style={{
          position: 'absolute', left: '50%', top: 4, bottom: 4,
          width: 2, background: 'rgba(255,255,255,0.2)',
          transform: 'translateX(-50%)', borderRadius: 1,
        }} />

        {/* ▲先手 ラベル */}
        <div style={{
          position: 'absolute', left: 8, top: 0, bottom: 0,
          display: 'flex', alignItems: 'center',
          color: 'rgba(255,255,255,0.92)', fontSize: 13, fontWeight: 'bold',
          textShadow: '0 1px 3px rgba(0,0,0,0.9)',
          pointerEvents: 'none', userSelect: 'none',
        }}>
          ▲先手
        </div>

        {/* △後手 ラベル */}
        <div style={{
          position: 'absolute', right: 8, top: 0, bottom: 0,
          display: 'flex', alignItems: 'center',
          color: 'rgba(255,200,200,0.95)', fontSize: 13, fontWeight: 'bold',
          textShadow: '0 1px 3px rgba(0,0,0,0.9)',
          pointerEvents: 'none', userSelect: 'none',
        }}>
          後手△
        </div>

        {/* 中央スコア */}
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          {isAnalyzing && blackScore === null ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Spinner />
              <span style={{
                fontSize: 14, color: 'rgba(255,255,255,0.85)',
                textShadow: '0 1px 4px rgba(0,0,0,0.9)',
              }}>解析中...</span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1 }}>
              <span style={{
                fontSize: 20, fontWeight: 'bold', color: '#fff',
                textShadow: '0 1px 6px rgba(0,0,0,0.95)',
                letterSpacing: 1,
              }}>
                {scorePrimary()}
              </span>
              {(advantage || isAnalyzing) && (
                <span style={{
                  fontSize: 10, color: 'rgba(255,255,255,0.7)',
                  textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                  marginTop: 1,
                }}>
                  {advantage}
                  {isAnalyzing ? (advantage ? ' · 解析中' : '解析中') : (depthLabel ? ` · ${depthLabel}` : '')}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 手番バッジ */}
      <div style={{
        textAlign: 'center', fontSize: 11, color: '#5c3317',
        background: '#f0e6d0', border: '1px solid #c8a96e',
        borderRadius: 12, padding: '2px 12px', marginTop: 5,
      }}>
        {turn === 0 ? '▲ 先手番' : '△ 後手番'}
        {depthLabel && !isAnalyzing && (
          <span style={{ marginLeft: 8, color: '#888', fontSize: 10 }}>{depthLabel}</span>
        )}
      </div>
    </div>
  );
}

// ---- スピナー ----
function Spinner() {
  return (
    <div style={{
      width: 14, height: 14,
      border: '2px solid rgba(255,255,255,0.3)',
      borderTop: '2px solid rgba(255,255,255,0.9)',
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
    }} />
  );
}

// ---- ナビゲーションバー ----
function NavBar({ nav, flipped, onFlip }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
      padding: '5px 8px', background: '#f0e6d0',
      border: '1px solid #c8a96e', borderRadius: 8,
      boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.06)',
    }}>
      <NavBtn label="|◀" title="最初へ (Home)" onClick={nav.onFirst} disabled={!nav.canFirst} />
      <NavBtn label="◀" title="1手戻る (←)" onClick={nav.onPrev} disabled={!nav.canPrev} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <NavBtn label="▲" title="前の分岐 (↑)" onClick={nav.onUp} disabled={!nav.canSibling} small />
        <NavBtn label="▼" title="次の分岐 (↓)" onClick={nav.onDown} disabled={!nav.canSibling} small />
      </div>
      <NavBtn label="▶" title="1手進む (→)" onClick={nav.onNext} disabled={!nav.canNext} />
      <NavBtn label="▶|" title="最後へ (End)" onClick={nav.onLast} disabled={!nav.canLast} />
      <NavBtn
        label="⇅ 反転"
        title={flipped ? '先手視点に戻す' : '盤面反転（後手視点）'}
        onClick={onFlip}
        active={flipped}
      />
    </div>
  );
}

function NavBtn({ label, title, onClick, disabled, small, active }) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        minWidth: small ? 30 : 42,
        padding: small ? '1px 6px' : '7px 10px',
        fontSize: small ? 11 : 14, lineHeight: 1.1,
        background: disabled
          ? '#e6ddc8'
          : active
          ? 'linear-gradient(135deg, #e8d5a3, #d4b872)'
          : 'linear-gradient(135deg, #fdf6e3, #e8d5a3)',
        color: disabled ? '#b7ab90' : '#5c3317',
        border: `1.5px solid ${disabled ? '#d6c9a8' : '#8b5e3c'}`,
        borderRadius: 5,
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
        fontWeight: 'bold',
        boxShadow: disabled ? 'none' : '0 1px 2px rgba(0,0,0,0.12)',
        opacity: disabled ? 0.55 : 1,
        transition: 'background 0.1s',
      }}
    >
      {label}
    </button>
  );
}

// ---- 持ち駒エリア ----
// 駒台。既定は縦長（盤の左右に配置）、horizontal=true で横長（モバイル・盤の上下に配置）。
// hoverKind = 候補手（駒打ち）ホバー/最善手プレビュー中の駒種
function HandArea({ label, hands, color, flipped, selected, onHandClick, hoverKind = null, horizontal = false }) {
  const hasAny = HAND_KINDS.some(k => (hands[k] ?? 0) > 0);
  const cells = (
    <>
        {!hasAny && (
          <span style={{
            fontSize: 10, color: '#bbb', fontFamily: 'serif',
            ...(horizontal ? {} : { writingMode: 'vertical-rl', marginTop: 6 }),
          }}>
            なし
          </span>
        )}
        {HAND_KINDS.map(kind => {
          const count = hands[kind] ?? 0;
          if (!count) return null;
          const isSel =
            selected?.type === 'hand' && selected.kind === kind && selected.color === color;
          // 候補手（駒打ち）ホバー：盤面の移動元ハイライトと同じ紫系（選択中は選択色を優先）
          const isHover = !isSel && hoverKind === kind;
          return (
            <div
              key={kind}
              onClick={() => onHandClick(kind, color)}
              style={{
                cursor: 'pointer', position: 'relative', padding: '2px 4px',
                background: isSel ? '#f0c060' : isHover ? 'rgba(140,60,200,0.22)' : 'transparent',
                border: `1.5px solid ${isSel ? '#c8a96e' : isHover ? 'rgba(140,60,200,0.8)' : 'transparent'}`,
                borderRadius: 4,
              }}
            >
              <HandPieceSVG kind={kind} color={color} flipped={flipped} />
              {count > 1 && (
                <span style={{
                  position: 'absolute', right: -3, bottom: -3,
                  minWidth: 14, height: 14, lineHeight: '12px', textAlign: 'center',
                  fontSize: 10, fontWeight: 'bold', color: '#5c3317',
                  background: '#fdf6e3', border: '1px solid #c8a96e', borderRadius: 7,
                  fontFamily: 'serif',
                }}>
                  {count}
                </span>
              )}
            </div>
          );
        })}
    </>
  );

  if (horizontal) {
    // 横長（モバイル・盤の上下配置）
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', boxSizing: 'border-box' }}>
        <span style={{ fontSize: 10, color: '#8b5e3c', fontFamily: 'serif', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <div style={{
          flex: 1, minHeight: 46, boxSizing: 'border-box',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
          padding: '3px 6px', flexWrap: 'wrap',
          background: '#f0e6d0', borderRadius: 4, border: '1px solid #c8a96e',
        }}>
          {cells}
        </div>
      </div>
    );
  }

  // 縦長（デスクトップ・盤の左右配置）
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      // 盤の筋ラベル行（CELL*0.4）ぶん下げて盤面と上端を揃える
      marginTop: CELL * 0.4,
    }}>
      <div style={{ fontSize: 10, color: '#8b5e3c', marginBottom: 3, fontFamily: 'serif', whiteSpace: 'nowrap' }}>
        {label}
      </div>
      <div style={{
        width: 52, height: CELL * 9 - 16, boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
        padding: '8px 2px',
        background: '#f0e6d0', borderRadius: 4, border: '1px solid #c8a96e',
      }}>
        {cells}
      </div>
    </div>
  );
}

const promBtnStyle = {
  padding: '9px 22px',
  background: 'linear-gradient(135deg, #c8a96e, #a0784a)',
  color: '#fff', border: 'none', borderRadius: 6, fontSize: 14,
  cursor: 'pointer', fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
  boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
};
