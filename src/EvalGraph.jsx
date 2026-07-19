import { useRef, useState, useEffect } from 'react';
import { blunderLoss, lossMark } from './winrate';

const CLAMP = 2000; // 評価値の表示上限（詰み ±99999 が軸を壊さないように）
const H = 180;      // グラフ高さ(px)

// 疑問手判定（ShogiTree と同一の勝率損失方式）。
// 親局面の最善手評価値は bestCp（保存済み）を優先し、無ければ直前ノードの評価値で代用。
function blunderAt(prev, cur) {
  if (cur.cp == null) return null;
  const bestCp = cur.bestCp ?? prev?.cp ?? null;
  const isBlackMove = cur.ply % 2 === 1; // 奇数手目＝先手の手
  return lossMark(blunderLoss(cur.cp, bestCp, isBlackMove));
}

/**
 * 評価値グラフ（SVG直描画）
 * @param line 現在のライン [{ nodeId, ply, cp:number|null, isMate, bestCp }]
 * @param selectedNodeId 選択中ノード
 * @param onSelectNode クリックでジャンプ
 */
export default function EvalGraph({ line, selectedNodeId, onSelectNode }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(480);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setWidth(Math.max(120, e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const padL = 36, padR = 12, padT = 10, padB = 18;
  const plotW = Math.max(10, width - padL - padR);
  const plotH = H - padT - padB;
  const midY = padT + plotH / 2;

  const analyzed = line.filter(e => e.cp != null);
  const hasData = analyzed.length > 0;

  const plyMin = line.length ? line[0].ply : 0;
  const plyMax = line.length ? line[line.length - 1].ply : 1;
  const plySpan = Math.max(1, plyMax - plyMin);

  const xOf = (ply) => padL + ((ply - plyMin) / plySpan) * plotW;
  const clamp = (v) => Math.max(-CLAMP, Math.min(CLAMP, v));
  const yOf = (cp) => midY - (clamp(cp) / CLAMP) * (plotH / 2);

  // 未解析ノードで区間を分割（線を途切れさせる）
  const segments = [];
  let seg = [];
  for (const e of line) {
    if (e.cp == null) { if (seg.length) segments.push(seg); seg = []; }
    else seg.push(e);
  }
  if (seg.length) segments.push(seg);

  const selEntry = line.find(e => e.nodeId === selectedNodeId);
  const selPly = selEntry ? selEntry.ply : null;

  function handleClick(ev) {
    if (!line.length) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    let best = line[0], bestD = Infinity;
    for (const e of line) {
      const d = Math.abs(xOf(e.ply) - x);
      if (d < bestD) { bestD = d; best = e; }
    }
    onSelectNode(best.nodeId);
  }

  return (
    <div ref={wrapRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {!hasData && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: '#b7a888', fontSize: 12,
          fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
          pointerEvents: 'none',
        }}>
          評価値データがありません（「棋譜解析」で評価値を付けてください）
        </div>
      )}
      <svg
        width={width} height={H}
        onClick={handleClick}
        style={{ display: 'block', cursor: 'pointer' }}
      >
        <defs>
          <clipPath id="eg-top"><rect x="0" y="0" width={width} height={midY} /></clipPath>
          <clipPath id="eg-bot"><rect x="0" y={midY} width={width} height={H - midY} /></clipPath>
        </defs>

        {/* 補助グリッド（±1000） */}
        {[1000, -1000].map(v => (
          <line key={v} x1={padL} x2={width - padR} y1={yOf(v)} y2={yOf(v)}
            stroke="#e6dabc" strokeWidth="1" />
        ))}

        {/* Y軸ラベル */}
        <text x={3} y={yOf(2000) + 3} fontSize="9" fill="#8b5e3c">+2000</text>
        <text x={3} y={midY + 3} fontSize="9" fill="#8b5e3c">0</text>
        <text x={3} y={yOf(-2000) + 3} fontSize="9" fill="#8b5e3c">-2000</text>

        {/* 面塗り：上半分＝先手色(黒系)、下半分＝後手色(赤系) */}
        {segments.map((s, si) => {
          if (s.length < 2) return null;
          const pts = s.map(e => `${xOf(e.ply)},${yOf(e.cp)}`).join(' ');
          const area = `${xOf(s[0].ply)},${midY} ${pts} ${xOf(s[s.length - 1].ply)},${midY}`;
          return (
            <g key={`a-${si}`}>
              <polygon points={area} fill="rgba(26,26,26,0.5)" clipPath="url(#eg-top)" />
              <polygon points={area} fill="rgba(178,35,26,0.45)" clipPath="url(#eg-bot)" />
            </g>
          );
        })}

        {/* 0 基準線 */}
        <line x1={padL} x2={width - padR} y1={midY} y2={midY}
          stroke="#8b5e3c" strokeWidth="1.2" strokeDasharray="4 3" />

        {/* 折れ線 */}
        {segments.map((s, si) => s.length >= 2 && (
          <polyline key={`l-${si}`}
            points={s.map(e => `${xOf(e.ply)},${yOf(e.cp)}`).join(' ')}
            fill="none" stroke="#2a1500" strokeWidth="1.6"
            strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* 各解析点のドット */}
        {analyzed.map((e, i) => (
          <circle key={`d-${i}`} cx={xOf(e.ply)} cy={yOf(e.cp)} r="2.2" fill="#3a1a00" />
        ))}

        {/* 疑問手マーカー */}
        {line.map((e, i) => {
          const mark = blunderAt(line[i - 1], e);
          if (!mark) return null;
          return (
            <circle key={`m-${i}`}
              cx={xOf(e.ply)} cy={yOf(e.cp)} r="4.5"
              fill={mark === '??' ? '#d32f2f' : '#ef8c1a'}
              stroke="#fff" strokeWidth="1" />
          );
        })}

        {/* 選択中の手：縦線マーカー */}
        {selPly != null && (
          <line x1={xOf(selPly)} x2={xOf(selPly)} y1={padT} y2={H - padB}
            stroke="#2563eb" strokeWidth="1.5" />
        )}
      </svg>
    </div>
  );
}
