import { useRef, useState, useEffect } from 'react';

const CLAMP = 2000; // 評価値の表示上限（詰み ±99999 が軸を壊さないように）
const H = 180;      // グラフ高さ(px)

const COLOR_A = '#1d4ed8'; // 変化A（青）
const COLOR_B = '#ea580c'; // 変化B（橙）

// 未解析ノード(cp==null)で区間を分割し、線を途切れさせる
function segmentsOf(line) {
  const segs = [];
  let seg = [];
  for (const e of line) {
    if (e.cp == null) { if (seg.length) segs.push(seg); seg = []; }
    else seg.push(e);
  }
  if (seg.length) segs.push(seg);
  return segs;
}

/**
 * 分岐比較ビュー：2つの変化の評価値推移を1つのグラフに重ね描きする（SVG直描画）
 * @param lineA 変化A [{ nodeId, ply, cp:number|null, isMate }]（ルート→ノードA）
 * @param lineB 変化B（ルート→ノードB）
 * @param divergePly 分岐点（共通の親）の手数。縦線を引く。null なら描かない
 * @param labelA 凡例に出す変化Aの名前
 * @param labelB 凡例に出す変化Bの名前
 * @param onClose 比較を閉じる
 */
export default function CompareView({ lineA, lineB, divergePly, labelA, labelB, onClose }) {
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

  const all = [...lineA, ...lineB];
  const analyzed = all.filter(e => e.cp != null);
  const hasData = analyzed.length > 0;

  // X軸は両ラインの手数の全域をカバー
  const plys = all.map(e => e.ply);
  const plyMin = plys.length ? Math.min(...plys) : 0;
  const plyMax = plys.length ? Math.max(...plys) : 1;
  const plySpan = Math.max(1, plyMax - plyMin);

  const xOf = (ply) => padL + ((ply - plyMin) / plySpan) * plotW;
  const clamp = (v) => Math.max(-CLAMP, Math.min(CLAMP, v));
  const yOf = (cp) => midY - (clamp(cp) / CLAMP) * (plotH / 2);

  const segsA = segmentsOf(lineA);
  const segsB = segmentsOf(lineB);

  // 各ラインの末端評価値（凡例用）
  const lastCp = (line) => {
    for (let i = line.length - 1; i >= 0; i--) if (line[i].cp != null) return line[i];
    return null;
  };
  const endA = lastCp(lineA);
  const endB = lastCp(lineB);
  const fmtCp = (e) => {
    if (!e || e.cp == null) return '—';
    if (e.isMate) return e.cp > 0 ? '先手詰' : '後手詰';
    return (e.cp > 0 ? '+' : '') + e.cp;
  };

  const renderLine = (segs, color, keyPrefix) => (
    <g key={keyPrefix}>
      {segs.map((s, si) => s.length >= 2 && (
        <polyline key={`${keyPrefix}-l-${si}`}
          points={s.map(e => `${xOf(e.ply)},${yOf(e.cp)}`).join(' ')}
          fill="none" stroke={color} strokeWidth="1.8"
          strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {segs.flat().map((e, i) => (
        <circle key={`${keyPrefix}-d-${i}`} cx={xOf(e.ply)} cy={yOf(e.cp)} r="2.4"
          fill={color} stroke="#fff" strokeWidth="0.8" />
      ))}
    </g>
  );

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* 凡例＋閉じるボタン */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        fontSize: 11, color: '#3a1a00',
        fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
        marginBottom: 2,
      }}>
        <span style={{ fontWeight: 'bold', color: '#8b5e3c' }}>分岐比較</span>
        <LegendItem color={COLOR_A} label={labelA} value={fmtCp(endA)} />
        <LegendItem color={COLOR_B} label={labelB} value={fmtCp(endB)} />
        <button
          onClick={onClose}
          style={{
            marginLeft: 'auto', padding: '2px 10px', fontSize: 11, cursor: 'pointer',
            background: '#f0e6d0', color: '#5c3317', border: '1px solid #8b5e3c',
            borderRadius: 4, fontFamily: 'inherit',
          }}
          title="比較を閉じて通常のグラフに戻る"
        >
          ✕ 閉じる
        </button>
      </div>

      <div ref={wrapRef} style={{ width: '100%', flex: 1, minHeight: 0, position: 'relative' }}>
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
        <svg width={width} height={H} style={{ display: 'block' }}>
          {/* 補助グリッド（±1000） */}
          {[1000, -1000].map(v => (
            <line key={v} x1={padL} x2={width - padR} y1={yOf(v)} y2={yOf(v)}
              stroke="#e6dabc" strokeWidth="1" />
          ))}

          {/* Y軸ラベル */}
          <text x={3} y={yOf(2000) + 3} fontSize="9" fill="#8b5e3c">+2000</text>
          <text x={3} y={midY + 3} fontSize="9" fill="#8b5e3c">0</text>
          <text x={3} y={yOf(-2000) + 3} fontSize="9" fill="#8b5e3c">-2000</text>

          {/* 0 基準線 */}
          <line x1={padL} x2={width - padR} y1={midY} y2={midY}
            stroke="#8b5e3c" strokeWidth="1.2" strokeDasharray="4 3" />

          {/* 分岐点の縦線（共通の親の手数） */}
          {divergePly != null && divergePly >= plyMin && divergePly <= plyMax && (
            <g>
              <line x1={xOf(divergePly)} x2={xOf(divergePly)} y1={padT} y2={H - padB}
                stroke="#6b7280" strokeWidth="1.2" strokeDasharray="3 3" />
              <text x={xOf(divergePly) + 3} y={padT + 9} fontSize="9" fill="#6b7280">
                分岐 {divergePly}手
              </text>
            </g>
          )}

          {/* 2変化の折れ線を重ね描き */}
          {renderLine(segsB, COLOR_B, 'B')}
          {renderLine(segsA, COLOR_A, 'A')}
        </svg>
      </div>
    </div>
  );
}

function LegendItem({ color, label, value }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 220, overflow: 'hidden' }}>
      <span style={{ width: 14, height: 3, background: color, borderRadius: 2, flexShrink: 0 }} />
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </span>
      <span style={{ color: '#8b5e3c', flexShrink: 0 }}>({value})</span>
    </span>
  );
}
