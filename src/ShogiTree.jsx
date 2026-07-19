import { useCallback, useState, useRef, useEffect } from 'react';
import ReactFlow, {
  Controls,
  Background,
  MiniMap,
  Handle,
  Position,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { v4 as uuidv4 } from 'uuid';
import { layoutTree } from './treeLayout';
import { blunderMark } from './winrate';
import { collapseChain, expandGroupNode } from './treeGroups';

// 後方互換：App 等が従来どおり ShogiTree から import できるように再公開
export { blunderMark };

// ---- 評価値表示ヘルパー（先手視点で統一） ----
function fmtEval(ev) {
  if (!ev) return null;
  if (ev.isMate || Math.abs(ev.cp) >= 99999) return ev.cp > 0 ? '＋詰み' : '－詰み';
  return (ev.cp >= 0 ? '+' : '') + ev.cp;
}
function evalColor(ev) {
  if (!ev) return '#888';
  if (ev.isMate || Math.abs(ev.cp) >= 99999) return ev.cp > 0 ? '#12351a' : '#8b1a1a';
  return ev.cp > 0 ? '#1a3a1a' : ev.cp < 0 ? '#8b1a1a' : '#555';
}

// 疑問手バッジ（? = オレンジ / ?? = 赤）
function BlunderBadge({ mark }) {
  if (!mark) return null;
  const is2 = mark === '??';
  return (
    <div style={{
      position: 'absolute', top: -9, right: -9, zIndex: 3,
      minWidth: 20, height: 20, padding: '0 4px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: is2 ? '#d32f2f' : '#ef8c1a',
      color: '#fff', fontSize: 12, fontWeight: 'bold', lineHeight: 1,
      borderRadius: 10, border: '1.5px solid #fff',
      boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
    }}>{mark}</div>
  );
}

// ---- カスタムノード：通常の指し手 ----
function ShogiNode({ data }) {
  const border = data.isGroupSel
    ? '2.5px dashed #e07b00'
    : data.isActive
    ? '2.5px solid #2563eb'
    : '2px solid #8b5e3c';
  return (
    <div style={{
      position: 'relative',
      background: data.isActive
        ? 'linear-gradient(135deg, #d4edff 0%, #b8d8f5 100%)'
        : 'linear-gradient(135deg, #fdf6e3 0%, #f5e6c8 100%)',
      border, borderRadius: 6, padding: '8px 14px', minWidth: 90,
      textAlign: 'center',
      boxShadow: data.isGroupSel
        ? '0 0 0 3px rgba(224,123,0,0.22), 0 2px 6px rgba(0,0,0,0.12)'
        : data.isActive
        ? '0 0 0 3px rgba(37,99,235,0.25), 0 4px 12px rgba(0,0,0,0.15)'
        : '0 2px 6px rgba(0,0,0,0.12)',
      cursor: 'pointer',
      fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
    }}>
      <BlunderBadge mark={data.blunder} />
      <Handle type="target" position={Position.Top} style={{ background: '#8b5e3c' }} />
      <div style={{ fontSize: 13, color: '#1a0050', fontWeight: 'bold' }}>{data.label}</div>
      {data.eval && (
        <div style={{ fontSize: 10, fontWeight: 'bold', color: evalColor(data.eval), marginTop: 2 }}>
          {fmtEval(data.eval)}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: '#8b5e3c' }} />
    </div>
  );
}

// ---- カスタムノード：集約（グループ）ノード ----
// data.auto: undefined=手動（紫・実線） / 'collapse'=自動折りたたみ（紫・破線） / 'best'=最善手ライン（ティール・💡）
function GroupNode({ data }) {
  const isBest = data.auto === 'best';
  const isAutoCollapse = data.auto === 'collapse';
  const accent = isBest ? '#0d9488' : '#7c3aed';        // 枠・ハンドルの基調色
  const accentDark = isBest ? '#115e59' : '#3b0a70';    // ラベル文字色
  const backCard = isBest ? '#ccfbf1' : '#ede9fe';
  const backBorder = isBest ? '#5eead4' : '#a78bfa';
  const bodyBg = isBest
    ? (data.isActive ? 'linear-gradient(135deg, #ccfbf1 0%, #99f6e4 100%)' : 'linear-gradient(135deg, #f0fdfa 0%, #ccfbf1 100%)')
    : (data.isActive ? 'linear-gradient(135deg, #ede9fe 0%, #ddd6fe 100%)' : 'linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%)');
  const borderStyle = isAutoCollapse ? 'dashed' : 'solid'; // 自動折りたたみは破線で手動と区別
  const border = data.isGroupSel
    ? '2.5px dashed #e07b00'
    : data.isActive
    ? `2.5px ${borderStyle} ${isBest ? '#0f766e' : '#6d28d9'}`
    : `2px ${borderStyle} ${accent}`;
  const icon = isBest ? '💡' : '📁';
  return (
    <div style={{ position: 'relative' }}>
      <BlunderBadge mark={data.blunder} />
      {/* 重なりを表現する背面カード */}
      <div style={{
        position: 'absolute', inset: 0, transform: 'translate(4px,4px)',
        background: backCard, border: `2px solid ${backBorder}`, borderRadius: 8,
      }} />
      <div style={{
        position: 'relative',
        background: bodyBg,
        border, borderRadius: 8, padding: '9px 15px', minWidth: 110,
        textAlign: 'center',
        boxShadow: data.isActive
          ? `0 0 0 3px ${isBest ? 'rgba(13,148,136,0.25)' : 'rgba(109,40,217,0.25)'}, 0 4px 12px rgba(0,0,0,0.16)`
          : '0 2px 8px rgba(0,0,0,0.14)',
        cursor: 'pointer',
        fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
      }}>
        <Handle type="target" position={Position.Top} style={{ background: accent }} />
        <div style={{ fontSize: 13, color: accentDark, fontWeight: 'bold' }}>
          {icon} {data.label}
        </div>
        <div style={{ fontSize: 10, color: accent, marginTop: 2 }}>
          {isBest ? '最善手ライン' : `${data.count}手をまとめ`}
          {isAutoCollapse ? ' ・ 自動' : ''}{data.memo ? ' ・ 📝メモあり' : ''}
        </div>
        {data.eval && (
          <div style={{ fontSize: 10, fontWeight: 'bold', color: evalColor(data.eval), marginTop: 1 }}>
            {fmtEval(data.eval)}
          </div>
        )}
        <div style={{ fontSize: 9, color: isBest ? '#2dd4bf' : '#9d7bd8', marginTop: 1 }}>
          ダブルクリックで展開
        </div>
        <Handle type="source" position={Position.Bottom} style={{ background: accent }} />
      </div>
    </div>
  );
}

const nodeTypes = { shogiNode: ShogiNode, groupNode: GroupNode };

// ミニマップの色分け：?=オレンジ / ??=赤 / グループ=紫（最善手ライン=ティール）
function miniNodeColor(node) {
  if (node.type === 'groupNode') return node.data?.auto === 'best' ? '#0d9488' : '#7c3aed';
  if (node.data?.blunder === '??') return '#d32f2f';
  if (node.data?.blunder === '?') return '#ef8c1a';
  return '#c8a96e';
}

function collectDescendants(nodeId, edges) {
  const children = edges.filter(e => e.source === nodeId).map(e => e.target);
  return children.reduce(
    (acc, id) => [...acc, id, ...collectDescendants(id, edges)],
    [],
  );
}

// ラベルから先頭の手数プレフィックス（例「12. 」）を除去
function cleanLabel(s) {
  return String(s ?? '').replace(/^\d+\.\s*/, '').trim();
}

/**
 * 選択ノード群が「分岐のない連続した一本道」か検証する。
 * @returns {ok:true, chain:string[]} | {ok:false, error:string}
 */
function analyzeChain(ids, nodes, edges) {
  if (!ids || ids.length < 2) {
    return { ok: false, error: 'グループ化には2つ以上のノードを選択してください' };
  }
  if (ids.includes('root')) {
    return { ok: false, error: 'ルート（初期局面）はグループ化できません' };
  }
  const idSet = new Set(ids);
  const parentOf = {};
  const childrenOf = {};
  for (const e of edges) {
    parentOf[e.target] = e.source;
    (childrenOf[e.source] ??= []).push(e.target);
  }
  // 先頭 = 親が選択外のノード。ちょうど1つでなければ不連続。
  const heads = ids.filter(id => !idSet.has(parentOf[id]));
  if (heads.length !== 1) {
    return { ok: false, error: '不連続な選択です。連続した一本道を選んでください' };
  }
  const chain = [];
  let cur = heads[0];
  while (cur && idSet.has(cur)) {
    chain.push(cur);
    const kids = childrenOf[cur] ?? [];
    const selKids = kids.filter(k => idSet.has(k));
    if (selKids.length > 1) {
      return { ok: false, error: '分岐を含む選択はグループ化できません' };
    }
    if (selKids.length === 1) {
      // 途中ノードは子が1つ（分岐なし）でなければならない
      if (kids.length > 1) {
        return { ok: false, error: '分岐を含む選択はグループ化できません' };
      }
      cur = selKids[0];
    } else {
      cur = null; // 末尾に到達
    }
  }
  if (chain.length !== ids.length) {
    return { ok: false, error: '不連続な選択です。連続した一本道を選んでください' };
  }
  return { ok: true, chain };
}

export default function ShogiTree({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  selectedNodeId,
  onNodeSelect,
  setNodes,
  setEdges,
}) {
  const [popup, setPopup] = useState(null);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [modal, setModal] = useState(null);
  const [inputText, setInputText] = useState('');
  const [memoText, setMemoText] = useState('');
  const [groupSel, setGroupSel] = useState([]); // Shift+クリックの複数選択
  const inputRef = useRef(null);
  const rfRef = useRef(null);   // React Flow インスタンス（onInit で取得）
  const wrapRef = useRef(null); // ツリーの表示領域
  const [showMiniMap, setShowMiniMap] = useState(
    () => localStorage.getItem('shogi-show-minimap') !== '0'); // 既定=表示
  useEffect(() => {
    localStorage.setItem('shogi-show-minimap', showMiniMap ? '1' : '0');
  }, [showMiniMap]);

  // ---- dagre 自動レイアウト ----
  const [layoutTick, setLayoutTick] = useState(0); // レイアウト後にオートパンを再評価させる
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const applyLayout = useCallback(() => {
    setNodes(nds => layoutTree(nds, edgesRef.current));
    setLayoutTick(t => t + 1);
  }, [setNodes]);

  // 構造（ノード集合・エッジ集合）が変わったら全体を再レイアウトする。
  // 追加・削除・グループ化・展開・KIF/JSONインポートはすべてここで拾える。
  // ドラッグや評価値の更新は構造が変わらないためレイアウトされない（手動配置は次の構造変化まで保持）。
  const structSig =
    nodes.map(n => n.id).sort().join(',') + '#' +
    edges.map(e => `${e.source}>${e.target}`).sort().join(',');
  const prevSigRef = useRef(null);
  useEffect(() => {
    if (prevSigRef.current === structSig) return;
    const isFirst = prevSigRef.current === null;
    prevSigRef.current = structSig;
    if (isFirst) return; // 初回マウントは保存済みの配置を尊重する
    applyLayout();
  }, [structSig, applyLayout]);

  // 選択ノードが画面外/端に近い時だけ、同ズームを保ってスムーズにパン
  useEffect(() => {
    const rf = rfRef.current;
    const wrap = wrapRef.current;
    if (!rf || !wrap) return;
    const node = rf.getNode(selectedNodeId);
    if (!node) return;

    const { x: vx, y: vy, zoom } = rf.getViewport();
    const pos = node.positionAbsolute ?? node.position;
    const nw = node.width ?? 110;
    const nh = node.height ?? 50;
    // ノードのスクリーン座標
    const left = pos.x * zoom + vx;
    const top = pos.y * zoom + vy;
    const right = (pos.x + nw) * zoom + vx;
    const bottom = (pos.y + nh) * zoom + vy;

    const { width: W, height: H } = wrap.getBoundingClientRect();
    const margin = 48; // 端に近すぎる判定の余白
    const outOfView =
      left < margin || top < margin || right > W - margin || bottom > H - margin;

    if (outOfView) {
      // ノード中心を画面中央へ（ズームは維持）
      rf.setCenter(pos.x + nw / 2, pos.y + nh / 2, { zoom, duration: 400 });
    }
  }, [selectedNodeId, layoutTick]); // レイアウト変更後も追従する

  const groupSelSet = new Set(groupSel);
  // 親ノードと自ノードの評価値から疑問手を判定（共有関数 blunderMark を使用）
  const evalById = new Map(nodes.map(n => [n.id, n.data.eval ?? null]));
  const parentById = new Map(edges.map(e => [e.target, e.source]));
  const blunderOf = (n) => blunderMark(n.data, evalById.get(parentById.get(n.id)));
  const displayNodes = nodes.map(n => ({
    ...n,
    data: {
      ...n.data,
      isActive: n.id === selectedNodeId,
      isGroupSel: groupSelSet.has(n.id),
      blunder: blunderOf(n),
    },
  }));

  // ---- 単クリック／ダブルクリックの分離 ----
  // 採用方式: React Flow の onNodeClick はダブルクリックの1回目でも発火するため、
  // 単クリック側（盤面移動）を CLICK_DELAY ms のタイマーで遅延させ、
  // その間に onNodeDoubleClick が来たらタイマーをキャンセルして
  // 編集メニューだけを開く（＝単クリック確定はタイマー満了時のみ）。
  const CLICK_DELAY = 230;
  const clickTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(clickTimerRef.current), []); // アンマウント時に破棄

  const onNodeClick = useCallback((event, node) => {
    event.stopPropagation();
    if (event.shiftKey) {
      // 複数選択のトグル（ルートは除外）
      if (node.id === 'root') return;
      setGroupSel(prev =>
        prev.includes(node.id) ? prev.filter(id => id !== node.id) : [...prev, node.id],
      );
      setPopup(null);
      setCtxMenu(null);
      return;
    }
    setGroupSel([]);
    setPopup(null);
    setCtxMenu(null);
    // 単クリック確定を遅延（ダブルクリック時は onNodeDoubleClick がキャンセルする）
    clearTimeout(clickTimerRef.current);
    const nodeId = node.id;
    clickTimerRef.current = setTimeout(() => {
      onNodeSelect(nodeId); // 盤面をその局面へ（編集メニューは出さない）
    }, CLICK_DELAY);
  }, [onNodeSelect]);

  const onNodeContextMenu = useCallback((event, node) => {
    event.preventDefault();
    setPopup(null);
    setCtxMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
  }, []);

  const removeNode = useCallback((nodeId) => {
    if (nodeId === 'root') return;
    const descendantIds = collectDescendants(nodeId, edges);
    const idsToRemove = [nodeId, ...descendantIds];
    setNodes(nds => nds.filter(n => !idsToRemove.includes(n.id)));
    setEdges(eds => eds.filter(
      e => !idsToRemove.includes(e.source) && !idsToRemove.includes(e.target),
    ));
    onNodeSelect('root');
    setPopup(null);
    setCtxMenu(null);
  }, [edges, setNodes, setEdges, onNodeSelect]);

  const onPaneClick = useCallback(() => {
    setPopup(null);
    setCtxMenu(null);
  }, []);

  // ---- グループ化 ----
  function doGroup(nodeId) {
    const res = analyzeChain(groupSel, nodes, edges);
    if (!res.ok) {
      alert('グループ化できません：' + res.error);
      return;
    }
    // 配線ロジックは treeGroups.collapseChain（自動折りたたみと共通実装）
    const r = collapseChain(nodes, edges, res.chain); // ラベルは既定の「A 〜 B（N手）」
    setNodes(r.nodes);
    setEdges(r.edges);
    onNodeSelect(r.groupId);
    setGroupSel([]);
    setCtxMenu(null);
  }

  // ---- 展開（グループ解除） ----
  function expandGroup(groupId) {
    const gnode = nodes.find(n => n.id === groupId);
    if (!gnode || gnode.type !== 'groupNode') return;
    // 配線ロジックは treeGroups.expandGroupNode（「すべて展開」と共通実装）
    const r = expandGroupNode(nodes, edges, groupId);
    setNodes(r.nodes);
    setEdges(r.edges);
    onNodeSelect(r.tailId);
    setCtxMenu(null);
    setPopup(null);
  }

  const onNodeDoubleClick = useCallback((event, node) => {
    event.stopPropagation();
    clearTimeout(clickTimerRef.current); // 保留中の単クリック（盤面移動）をキャンセル
    if (node.type === 'groupNode') {
      expandGroup(node.id); // 集約ノードは従来どおりダブルクリックで展開
      return;
    }
    // 通常ノード: 編集メニュー（子ノード追加/編集/削除）を開く
    onNodeSelect(node.id);
    setPopup({ x: event.clientX, y: event.clientY, nodeId: node.id });
    setCtxMenu(null);
  }, [nodes, edges, onNodeSelect]); // eslint-disable-line react-hooks/exhaustive-deps

  function openAddModal(nodeId) {
    setInputText('');
    setModal({ mode: 'add', nodeId });
    setPopup(null);
    setCtxMenu(null);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function openEditModal(nodeId) {
    const node = nodes.find(n => n.id === nodeId);
    const isGroup = node?.type === 'groupNode';
    setInputText(node?.data.label || '');
    setMemoText(node?.data.memo || '');
    setModal({ mode: isGroup ? 'editGroup' : 'edit', nodeId });
    setPopup(null);
    setCtxMenu(null);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function confirmAdd() {
    if (!inputText.trim() || !modal) return;
    const parentNode = nodes.find(n => n.id === modal.nodeId);
    if (!parentNode) return;
    const siblings = edges.filter(e => e.source === modal.nodeId);
    const offsetX = (siblings.length - Math.floor(siblings.length / 2)) * 180;
    const newId = uuidv4();
    const newNode = {
      id: newId,
      type: 'shogiNode',
      position: {
        x: parentNode.position.x + offsetX,
        y: parentNode.position.y + 130,
      },
      data: {
        label: inputText.trim(),
        moves: parentNode.data.moves ?? [],
      },
    };
    setNodes(nds => [...nds, newNode]);
    setEdges(eds => [...eds, {
      id: `e-${modal.nodeId}-${newId}`,
      source: modal.nodeId,
      target: newId,
      style: { stroke: '#8b5e3c', strokeWidth: 2 },
    }]);
    onNodeSelect(newId);
    setModal(null);
  }

  function confirmEdit() {
    if (!inputText.trim() || !modal) return;
    setNodes(nds => nds.map(n =>
      n.id === modal.nodeId
        ? { ...n, data: { ...n.data, label: inputText.trim() } }
        : n,
    ));
    setModal(null);
  }

  function confirmEditGroup() {
    if (!inputText.trim() || !modal) return;
    setNodes(nds => nds.map(n =>
      n.id === modal.nodeId
        ? { ...n, data: { ...n.data, label: inputText.trim(), memo: memoText } }
        : n,
    ));
    setModal(null);
  }

  const confirmModal =
    modal?.mode === 'add' ? confirmAdd
    : modal?.mode === 'editGroup' ? confirmEditGroup
    : confirmEdit;

  // 選択中ノード（メモパネル用）
  const selectedNode = nodes.find(n => n.id === selectedNodeId);
  const showMemoPanel = selectedNode?.type === 'groupNode';

  // コンテキストメニュー対象
  const ctxNode = ctxMenu ? nodes.find(n => n.id === ctxMenu.nodeId) : null;
  const ctxIsGroup = ctxNode?.type === 'groupNode';
  const canGroup = ctxMenu && groupSel.length >= 2 && groupSel.includes(ctxMenu.nodeId);

  return (
    <div ref={wrapRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={displayNodes}
        edges={edges}
        onInit={(inst) => { rfRef.current = inst; }}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        disableKeyboardA11y
        minZoom={0.1}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        style={{ background: '#f9f3e8' }}
      >
        <Controls />
        <Background color="#d4b896" gap={24} size={1} />
        {showMiniMap && (
          <MiniMap
            pannable
            zoomable
            nodeStrokeWidth={2}
            nodeColor={miniNodeColor}
            style={{ background: '#f0e6d0', border: '1px solid #c8a96e' }}
          />
        )}
      </ReactFlow>

      {/* 整列・ミニマップ表示トグル */}
      <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 15, display: 'flex', gap: 6 }}>
        <button
          onClick={applyLayout}
          title="全ノードを自動整列（手動配置はリセットされます）"
          style={{
            fontSize: 11, cursor: 'pointer', padding: '3px 10px',
            background: '#fdf6e3', color: '#5c3317',
            border: '1.5px solid #8b5e3c', borderRadius: 5,
            fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
          }}
        >
          ⊞ 整列
        </button>
        <button
          onClick={() => setShowMiniMap(v => !v)}
          title="ミニマップの表示切替"
          style={{
            fontSize: 11, cursor: 'pointer', padding: '3px 10px',
            background: showMiniMap ? '#8b5e3c' : '#fdf6e3',
            color: showMiniMap ? '#f5e6c8' : '#5c3317',
            border: '1.5px solid #8b5e3c', borderRadius: 5,
            fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
          }}
        >
          🗺 ミニマップ {showMiniMap ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* 複数選択のヒント */}
      {groupSel.length > 0 && (
        <div style={{
          position: 'absolute', top: 8, left: 8, zIndex: 15,
          background: 'rgba(58,26,0,0.88)', color: '#f5e6c8',
          padding: '5px 12px', borderRadius: 6, fontSize: 12,
          fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
        }}>
          {groupSel.length}個 選択中 — 右クリックで「グループ化」
        </div>
      )}

      {/* 左クリックポップアップ */}
      {popup && (
        <div style={{
          position: 'fixed', top: popup.y + 8, left: popup.x + 8, zIndex: 20,
          background: '#fdf6e3', border: '1.5px solid #8b5e3c',
          borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.18)', overflow: 'hidden',
        }}>
          <PopupBtn onClick={() => openAddModal(popup.nodeId)}>＋ 子ノードを追加</PopupBtn>
          {popup.nodeId !== 'root' && (
            <PopupBtn onClick={() => openEditModal(popup.nodeId)}>✏ 編集</PopupBtn>
          )}
          {popup.nodeId !== 'root' && (
            <PopupBtn onClick={() => removeNode(popup.nodeId)} danger>
              🗑 削除（子も含む）
            </PopupBtn>
          )}
        </div>
      )}

      {/* 右クリック コンテキストメニュー */}
      {ctxMenu && (
        <div style={{
          position: 'fixed', top: ctxMenu.y + 4, left: ctxMenu.x + 4, zIndex: 20,
          background: '#fdf6e3', border: '1.5px solid #8b5e3c',
          borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.18)', overflow: 'hidden',
        }}>
          {canGroup && (
            <PopupBtn onClick={() => doGroup(ctxMenu.nodeId)}>
              ▣ グループ化（{groupSel.length}手）
            </PopupBtn>
          )}
          {ctxIsGroup && (
            <PopupBtn onClick={() => expandGroup(ctxMenu.nodeId)}>⊟ 展開（グループ解除）</PopupBtn>
          )}
          {ctxIsGroup && (
            <PopupBtn onClick={() => openEditModal(ctxMenu.nodeId)}>✏ ラベル・メモを編集</PopupBtn>
          )}
          {!ctxIsGroup && ctxMenu.nodeId !== 'root' && (
            <PopupBtn onClick={() => openEditModal(ctxMenu.nodeId)}>✏ 編集</PopupBtn>
          )}
          {ctxMenu.nodeId !== 'root' && (
            <PopupBtn onClick={() => removeNode(ctxMenu.nodeId)} danger>🗑 削除（子も含む）</PopupBtn>
          )}
        </div>
      )}

      {/* グループのメモパネル */}
      {showMemoPanel && (
        <div style={{
          position: 'absolute', bottom: 12, left: 12, zIndex: 15, maxWidth: 300,
          background: '#f5f3ff', border: '2px solid #7c3aed', borderRadius: 8,
          padding: '10px 14px', boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
        }}>
          <div style={{ fontSize: 13, fontWeight: 'bold', color: '#3b0a70', marginBottom: 4 }}>
            📁 {selectedNode.data.label}
          </div>
          <div style={{
            fontSize: 12, color: '#4b3a66', whiteSpace: 'pre-wrap',
            maxHeight: 120, overflow: 'auto',
          }}>
            {selectedNode.data.memo
              ? selectedNode.data.memo
              : <span style={{ color: '#9d7bd8' }}>メモは未設定です</span>}
          </div>
          <button
            onClick={() => openEditModal(selectedNode.id)}
            style={{
              marginTop: 8, padding: '4px 12px', fontSize: 12, cursor: 'pointer',
              background: 'linear-gradient(135deg, #a78bfa, #7c3aed)', color: '#fff',
              border: 'none', borderRadius: 5,
              fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
            }}
          >
            ✏ 編集
          </button>
        </div>
      )}

      {/* 入力モーダル */}
      {modal && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 30,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setModal(null)}
        >
          <div
            style={{
              background: '#fdf6e3', border: '2px solid #8b5e3c', borderRadius: 10,
              padding: '24px 32px', minWidth: 340,
              boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
              fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
            }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 16px', color: '#3a1a00', fontSize: 16 }}>
              {modal.mode === 'add' ? '子ノードを追加'
                : modal.mode === 'editGroup' ? 'グループを編集'
                : 'ノードを編集'}
            </h3>
            <label style={{ fontSize: 12, color: '#5c3317', display: 'block', marginBottom: 4 }}>
              ラベル（短文）
            </label>
            <input
              ref={inputRef}
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && modal.mode !== 'editGroup' && confirmModal()}
              placeholder={modal.mode === 'editGroup' ? '例：石田流の駒組み' : '例：７六歩、２六歩'}
              style={{
                width: '100%', padding: '8px 10px',
                border: '1.5px solid #8b5e3c', borderRadius: 4,
                fontSize: 15, background: '#fffdf5', color: '#3a1a00',
                boxSizing: 'border-box', fontFamily: 'inherit',
              }}
            />
            {modal.mode === 'editGroup' && (
              <>
                <label style={{ fontSize: 12, color: '#5c3317', display: 'block', margin: '12px 0 4px' }}>
                  メモ（長文可）
                </label>
                <textarea
                  value={memoText}
                  onChange={e => setMemoText(e.target.value)}
                  rows={4}
                  placeholder="この局面群の狙いや解説を自由に記入…"
                  style={{
                    width: '100%', padding: '8px 10px', resize: 'vertical',
                    border: '1.5px solid #8b5e3c', borderRadius: 4,
                    fontSize: 13, background: '#fffdf5', color: '#3a1a00',
                    boxSizing: 'border-box', fontFamily: 'inherit',
                  }}
                />
              </>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => setModal(null)} style={cancelBtnStyle}>キャンセル</button>
              <button onClick={confirmModal} style={primaryBtnStyle}>
                {modal.mode === 'add' ? '追加' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PopupBtn({ onClick, children, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block', width: '100%', padding: '9px 18px',
        background: 'none', border: 'none', borderBottom: '1px solid #e8d5a3',
        textAlign: 'left', cursor: 'pointer', fontSize: 13,
        color: danger ? '#c0392b' : '#3a1a00',
        fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = '#f5e6c8')}
      onMouseLeave={e => (e.currentTarget.style.background = 'none')}
    >
      {children}
    </button>
  );
}

const primaryBtnStyle = {
  padding: '7px 20px',
  background: 'linear-gradient(135deg, #c8a96e, #a0784a)',
  color: '#fff', border: 'none', borderRadius: 5, fontSize: 14,
  cursor: 'pointer', fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
};

const cancelBtnStyle = {
  padding: '7px 16px', background: '#f0e6d0', color: '#5c3317',
  border: '1.5px solid #8b5e3c', borderRadius: 5, fontSize: 14,
  cursor: 'pointer', fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
};
