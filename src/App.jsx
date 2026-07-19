import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useNodesState, useEdgesState } from 'reactflow';
import { v4 as uuidv4 } from 'uuid';
import ShogiBoard from './ShogiBoard';
import ShogiTree, { blunderMark } from './ShogiTree';
import EvalGraph from './EvalGraph';
import CompareView from './CompareView';
import { parseKif, readKifFile } from './kif';
import { analyzeLow, cancelBatch, toBlackScore } from './ShogiEngine';
import { autoCollapse, addBestBranches, expandAutoGroups, findBestChains, collapseBestChains } from './treeGroups';

const ROOT_ID = 'root';

// 解析の深さ設定
const DEPTH_MS = { small: 500, medium: 1500, large: 4000 };
const DEPTH_OPTIONS = [
  { key: 'small', label: '小 ・ 0.5秒/手', sub: 'ざっくり傾向把握' },
  { key: 'medium', label: '中 ・ 1.5秒/手', sub: '標準（推奨）' },
  { key: 'large', label: '大 ・ 4秒/手', sub: '精査' },
];
const DEPTH_SHORT = { small: '小・0.5秒/手', medium: '中・1.5秒/手', large: '大・4秒/手' };
// 解析中の盤面自動追従：ユーザー操作後、無操作がこの時間続いたら追従を再開する
const FOLLOW_RESUME_MS = 3000;
const DEPTH_KEY_LS = 'shogi-analysis-depth';
const AUTOSAVE_KEY = 'shogi-tree-autosave';

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// エクスポート用の日時スタンプ（ローカル時刻）: YYYY-MM-DD_HHmm
function fmtStamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// ファイル名に使えない文字（/ \ : * ? " < > |）をラベルから除去
function sanitizeFileName(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 60);
}

// ルート直下グループ、なければ最初のグループのラベルを返す
function findGroupLabel(nodes, edges) {
  const rootChildIds = edges.filter(e => e.source === ROOT_ID).map(e => e.target);
  const rootChildGroup = nodes.find(n => n.type === 'groupNode' && rootChildIds.includes(n.id));
  const group = rootChildGroup ?? nodes.find(n => n.type === 'groupNode');
  return group?.data?.label ?? null;
}

// エクスポートのファイル名を生成: shogi-tree_YYYY-MM-DD_HHmm[_ラベル].json
function buildExportName(nodes, edges, kifBaseName) {
  const stamp = fmtStamp(new Date());
  // 優先：グループラベル → KIF読み込み直後の元ファイル名
  const rawLabel = findGroupLabel(nodes, edges) ?? kifBaseName ?? null;
  const label = rawLabel ? sanitizeFileName(rawLabel) : '';
  return `shogi-tree_${stamp}${label ? '_' + label : ''}.json`;
}

// 2つの指し手が同一か（重複ノード判定用）
function sameMove(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'drop') {
    return a.tox === b.tox && a.toy === b.toy && a.kind === b.kind;
  }
  return a.fromx === b.fromx && a.fromy === b.fromy
    && a.tox === b.tox && a.toy === b.toy && !!a.promote === !!b.promote;
}
const initialNodes = [
  {
    id: ROOT_ID,
    type: 'shogiNode',
    position: { x: 0, y: 0 },
    data: { label: '平手初期局面', moves: [] },
  },
];

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNodeId, setSelectedNodeId] = useState(ROOT_ID);

  // ---- 解析中の盤面自動追従（ピヨ将棋風）----
  // 自動棋譜解析の実行中、エンジンが解析中の局面へ盤面（選択ノード）を自動で進める。
  // ユーザー操作（ノードクリック・矢印キー・盤面で指す）で一時停止し、
  // 無操作が FOLLOW_RESUME_MS 続いたら再開してその時点の解析中局面へ移動する。
  // 状態はすべて表示層の ref のみ（解析キュー・評価値キャッシュ・疑問手判定に触れない）
  const batchRunningRef = useRef(false); // 自動解析の実行中フラグ
  const analyzingIdRef = useRef(null);   // いまエンジンが解析中のノードid（解析中以外は null）
  const followPausedRef = useRef(false); // ユーザー操作による追従一時停止中か
  const followTimerRef = useRef(null);   // 追従再開タイマー（最終操作から FOLLOW_RESUME_MS）

  // ユーザー操作を記録：解析中なら追従を止め、無操作 FOLLOW_RESUME_MS 後に再開する
  const pauseFollowByUser = useCallback(() => {
    if (!batchRunningRef.current) return; // 解析中以外は何もしない
    followPausedRef.current = true;
    clearTimeout(followTimerRef.current);
    followTimerRef.current = setTimeout(() => {
      followPausedRef.current = false;
      if (batchRunningRef.current && analyzingIdRef.current) {
        setSelectedNodeId(analyzingIdRef.current);
      }
    }, FOLLOW_RESUME_MS);
  }, []);

  // 選択中ノードの手順リスト
  const currentMoves = useMemo(() => {
    const node = nodes.find(n => n.id === selectedNodeId);
    return node?.data.moves ?? [];
  }, [selectedNodeId, nodes]);

  // 盤面で駒を動かしたら選択ノードの子として追加（同じ手の子があればそこへ移動）
  const handleBoardMove = useCallback((moveInfo, kifText) => {
    pauseFollowByUser();
    const parentNode = nodes.find(n => n.id === selectedNodeId);
    if (!parentNode) return;

    // 既存の子で同じ手があればそこへ移動（重複追加しない）
    const childEdges = edges.filter(e => e.source === selectedNodeId);
    for (const ce of childEdges) {
      const child = nodes.find(n => n.id === ce.target);
      const cm = child?.data.moves;
      const last = cm && cm.length ? cm[cm.length - 1] : null;
      if (last && sameMove(last, moveInfo)) {
        setSelectedNodeId(child.id);
        return;
      }
    }

    const siblings = edges.filter(e => e.source === selectedNodeId);
    const sibCount = siblings.length;
    const offsetX = (sibCount - Math.floor(sibCount / 2)) * 180;
    const newId = uuidv4();
    const newNode = {
      id: newId,
      type: 'shogiNode',
      position: {
        x: parentNode.position.x + offsetX,
        y: parentNode.position.y + 130,
      },
      data: {
        label: kifText,
        moves: [...(parentNode.data.moves ?? []), moveInfo],
      },
    };
    setNodes(nds => [...nds, newNode]);
    setEdges(eds => [...eds, {
      id: `e-${selectedNodeId}-${newId}`,
      source: selectedNodeId,
      target: newId,
      style: { stroke: '#8b5e3c', strokeWidth: 2 },
    }]);
    setSelectedNodeId(newId);
  }, [nodes, edges, selectedNodeId, setNodes, setEdges, pauseFollowByUser]);

  // ツリーのノードを選択したら盤面をその局面に更新
  const handleNodeSelect = useCallback((nodeId) => {
    pauseFollowByUser();
    setSelectedNodeId(nodeId);
  }, [pauseFollowByUser]);

  // エンジン解析完了時に評価値をノードへ保存（深さが同等以下なら上書きしない）。
  // 併せて疑問手判定用に「親局面の最善手（multipv=1）評価値」を bestCp として保存する：
  //  - 自ノード保存時：親の評価値（＝親局面の multipv=1 スコア）を bestCp に写す
  //  - 親として保存されたとき：解析済みの子ノードへ bestCp を補完する
  // bestCp は data.eval 内にあるため JSON エクスポート/インポートでそのまま保存・復元される。
  const handleEval = useCallback((nodeId, ev) => {
    setNodes(nds => {
      const edges = batchEdgesRef.current;
      const parentId = edges.find(e => e.target === nodeId)?.source;
      const parentCp = nds.find(n => n.id === parentId)?.data.eval?.cp;
      const prev = nds.find(n => n.id === nodeId)?.data.eval;
      const accept = !(prev && prev.depth >= ev.depth);
      const childIds = new Set(edges.filter(e => e.source === nodeId).map(e => e.target));
      return nds.map(n => {
        if (n.id === nodeId) {
          if (!accept) {
            // 評価値は据え置きでも bestCp が欠けていれば補完する
            if (prev.bestCp == null && parentCp != null) {
              return { ...n, data: { ...n.data, eval: { ...prev, bestCp: parentCp } } };
            }
            return n;
          }
          const next = { cp: ev.cp, depth: ev.depth, isMate: ev.isMate };
          const bestCp = parentCp ?? prev?.bestCp;
          if (bestCp != null) next.bestCp = bestCp;
          if (ev.pv?.length) next.pv = ev.pv; // 最善手ブランチ生成用（multipv=1 の読み筋）
          return { ...n, data: { ...n.data, eval: next } };
        }
        // このノードが親として解析された → 子ノードの bestCp を更新
        if (accept && childIds.has(n.id) && n.data.eval) {
          return { ...n, data: { ...n.data, eval: { ...n.data.eval, bestCp: ev.cp } } };
        }
        return n;
      });
    });
  }, [setNodes]);

  // ---- 自動棋譜解析 ----
  const [analysisDepth, setAnalysisDepth] = useState(
    () => localStorage.getItem(DEPTH_KEY_LS) || 'medium');
  const [showSettings, setShowSettings] = useState(false);
  const [batch, setBatch] = useState(null); // { total, done, background, ms, depthKey } | null

  useEffect(() => { localStorage.setItem(DEPTH_KEY_LS, analysisDepth); }, [analysisDepth]);

  // 解析後のツリー自動整理の設定（runBatch は非同期のため ref 経由で最新値を参照）
  const [autoCollapseOn, setAutoCollapseOn] = useState(
    () => localStorage.getItem('shogi-auto-collapse') !== '0'); // 既定ON
  const [autoBestOn, setAutoBestOn] = useState(
    () => localStorage.getItem('shogi-auto-best') === '1');     // 既定OFF（ノードが増えるため）
  useEffect(() => { localStorage.setItem('shogi-auto-collapse', autoCollapseOn ? '1' : '0'); }, [autoCollapseOn]);
  useEffect(() => { localStorage.setItem('shogi-auto-best', autoBestOn ? '1' : '0'); }, [autoBestOn]);
  const autoCollapseOnRef = useRef(autoCollapseOn);
  autoCollapseOnRef.current = autoCollapseOn;
  const autoBestOnRef = useRef(autoBestOn);
  autoBestOnRef.current = autoBestOn;

  const batchCancelRef = useRef(false);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes; // 最新ノードを参照（解析中に埋まった評価値を検知）
  const batchEdgesRef = useRef(edges);
  batchEdgesRef.current = edges;
  const selectBlunderAfterRef = useRef(false); // サンプル読み込み時：解析後に最初の疑問手へ移動

  async function runBatch(todo, ms) {
    let done = 0;
    for (const item of todo) {
      if (batchCancelRef.current) break;
      // 既に評価値がある（対話解析で先に埋まった等）ならスキップ
      const cur = nodesRef.current.find(n => n.id === item.id);
      if (cur?.data.eval) { done++; setBatch(b => (b ? { ...b, done } : b)); continue; }

      // 盤面自動追従：これから解析する局面へ盤面を進める（ユーザー操作中は動かさない）
      analyzingIdRef.current = item.id;
      if (!followPausedRef.current) setSelectedNodeId(item.id);

      const result = await analyzeLow(item.moves, ms);
      if (batchCancelRef.current) break;
      if (result && result.score !== null) {
        const turn = item.moves.length % 2 === 0 ? 0 : 1; // 0=先手番 1=後手番
        const bs = toBlackScore(result.score, result.isMate, turn);
        const cp = result.isMate ? (bs > 0 ? 99999 : -99999) : bs;
        handleEval(item.id, {
          cp, depth: result.depth ?? 0, isMate: !!result.isMate,
          pv: (result.pv ?? []).slice(0, 7),
        });
      }
      done++;
      setBatch(b => (b ? { ...b, done } : b));
    }
    // 追従の後始末：解析終了（完了・キャンセルとも）後は盤面をどこにも動かさず現局面に留める
    analyzingIdRef.current = null;
    followPausedRef.current = false;
    clearTimeout(followTimerRef.current);
    batchRunningRef.current = false;
    setBatch(null);
    if (batchCancelRef.current) {
      selectBlunderAfterRef.current = false;
      return;
    }

    // ---- 解析完了後のツリー自動整理（追加解析なし・保存済み結果のみ使用）----
    let ns = nodesRef.current;
    let es = batchEdgesRef.current;
    let changed = false;
    if (autoBestOnRef.current) {
      const r = addBestBranches(ns, es);
      if (r.added > 0) { ns = r.nodes; es = r.edges; changed = true; }
    }
    if (autoCollapseOnRef.current) {
      const r = autoCollapse(ns, es);
      if (r.changed) { ns = r.nodes; es = r.edges; changed = true; }
    }
    if (changed) {
      setNodes(ns);
      setEdges(es);
      // 選択中ノードが集約に吸収された場合はそのグループを選択
      if (!ns.some(n => n.id === selRef.current)) {
        const g = ns.find(n => n.type === 'groupNode'
          && n.data.group?.nodes.some(x => x.id === selRef.current));
        if (g) setSelectedNodeId(g.id);
      }
    }

    // サンプル読み込み後：?/?? が付いた最初のノードを自動選択して盤面に表示
    // （疑問手ノードは自動折りたたみの保護対象なので集約後も存在する）
    if (selectBlunderAfterRef.current) {
      selectBlunderAfterRef.current = false;
      const parentById = new Map(es.map(e => [e.target, e.source]));
      const evalById = new Map(ns.map(n => [n.id, n.data.eval ?? null]));
      const marked = ns
        .filter(n => n.type === 'shogiNode'
          && blunderMark(n.data, evalById.get(parentById.get(n.id))))
        .sort((a, b) => (a.data.moves?.length ?? 0) - (b.data.moves?.length ?? 0));
      if (marked.length) setSelectedNodeId(marked[0].id);
    }
  }

  // 一時通知トースト（1.8秒で自動消滅）
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  function showToast(msg) {
    clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), 1800);
  }

  function startBatch(nodeArray) {
    if (batchRunningRef.current) return;
    const ms = DEPTH_MS[analysisDepth] ?? DEPTH_MS.medium;
    const todo = nodeArray
      .filter(n => !n.data.eval)
      .map(n => ({ id: n.id, moves: n.data.moves ?? [] }));
    if (todo.length === 0) {
      showToast('✓ すべてのノードが解析済みです');
      return;
    }
    batchCancelRef.current = false;
    batchRunningRef.current = true;
    setBatch({ total: todo.length, done: 0, background: false, ms, depthKey: analysisDepth });
    runBatch(todo, ms);
  }

  function cancelBatchAnalysis() {
    batchCancelRef.current = true;
    cancelBatch();
    batchRunningRef.current = false;
    setBatch(null);
  }

  // すべての自動集約（折りたたみ・最善手ライン）を展開する。手動グループは維持。
  function expandAllAuto() {
    const auto = nodes.filter(n => n.type === 'groupNode' && n.data.auto);
    if (auto.length === 0) {
      showToast('展開できる自動グループはありません');
      return;
    }
    const selGroup = auto.find(n => n.id === selectedNodeId);
    const r = expandAutoGroups(nodes, edges);
    setNodes(r.nodes);
    setEdges(r.edges);
    if (selGroup) setSelectedNodeId(selGroup.data.group?.tailId ?? ROOT_ID);
    showToast(`✓ 自動グループを${auto.length}件展開しました`);
  }

  // ---- 手動折りたたみ（対象をチェックで選ぶ）----
  const [showCollapseMenu, setShowCollapseMenu] = useState(false);
  const [collapsePlainChecked, setCollapsePlainChecked] = useState(true); // 平凡な手の連続
  const [collapseBestChecked, setCollapseBestChecked] = useState(true);   // 最善手ブランチ

  // チェックされた対象だけを機能19の既存折りたたみ（collapseChain 配線）で畳み直す
  function collapseSelectedNow() {
    setShowCollapseMenu(false);
    let ns = nodes;
    let es = edges;
    let bestCount = 0;
    let plainChanged = false;
    if (collapseBestChecked) {
      const r = collapseBestChains(ns, es);
      bestCount = r.count;
      ns = r.nodes;
      es = r.edges;
    }
    if (collapsePlainChecked) {
      // 最善手ブランチを畳まない指定のときは、その構成ノードを平凡手集約から保護する
      const exclude = collapseBestChecked ? [] : findBestChains(ns, es).flat();
      const r = autoCollapse(ns, es, exclude);
      plainChanged = r.changed;
      if (r.changed) {
        ns = r.nodes;
        es = r.edges;
      }
    }
    if (!bestCount && !plainChanged) {
      showToast('折りたたみ対象がありません');
      return;
    }
    setNodes(ns);
    setEdges(es);
    // 選択中ノードが集約に吸収された場合はそのグループを選択（解析後処理と同じ扱い）
    if (!ns.some(n => n.id === selRef.current)) {
      const g = ns.find(n => n.type === 'groupNode'
        && n.data.group?.nodes.some(x => x.id === selRef.current));
      if (g) setSelectedNodeId(g.id);
    }
    showToast('✓ 折りたたみました');
  }

  // 既存ツリーに対して最善手ブランチを後から追加（保存済みPVを使用・追加解析なし）
  function addBestBranchesNow() {
    const r = addBestBranches(nodes, edges);
    if (r.added === 0) {
      showToast('追加できる最善手ブランチがありません（旧データはPV未保存のため再解析が必要）');
      return;
    }
    setNodes(r.nodes);
    setEdges(r.edges);
    showToast(`✓ 最善手ブランチを${r.added}件追加しました`);
  }

  // 分岐時に「最後に訪れた子」を記憶（→ / End の優先先）
  const lastChildRef = useRef({});

  // ツリー探索ヘルパ（子は position.x 昇順で整列）
  const childrenOf = useCallback((id) => edges
    .filter(ed => ed.source === id)
    .map(ed => nodes.find(n => n.id === ed.target))
    .filter(Boolean)
    .sort((a, b) => (a.position.x - b.position.x) || (a.position.y - b.position.y)),
    [nodes, edges]);
  const parentOf = useCallback(
    (id) => edges.find(ed => ed.target === id)?.source ?? null,
    [edges]);

  // ---- ナビゲーション操作（キーボード・ボタン共用）----
  const navFirst = useCallback(() => {
    pauseFollowByUser();
    setSelectedNodeId(ROOT_ID);
  }, [pauseFollowByUser]);

  const navPrev = useCallback(() => {
    pauseFollowByUser();
    const p = parentOf(selectedNodeId);
    if (p) {
      lastChildRef.current[p] = selectedNodeId; // 戻り先を記憶
      setSelectedNodeId(p);
    }
  }, [parentOf, selectedNodeId, pauseFollowByUser]);

  const navNext = useCallback(() => {
    pauseFollowByUser();
    const kids = childrenOf(selectedNodeId);
    if (kids.length) {
      const remembered = lastChildRef.current[selectedNodeId];
      const target = kids.find(k => k.id === remembered) ?? kids[0];
      lastChildRef.current[selectedNodeId] = target.id;
      setSelectedNodeId(target.id);
    }
  }, [childrenOf, selectedNodeId, pauseFollowByUser]);

  const navLast = useCallback(() => {
    pauseFollowByUser();
    let cur = selectedNodeId;
    for (let i = 0; i < 1000; i++) { // 末端まで（最後に訪れた子を優先）
      const kids = childrenOf(cur);
      if (!kids.length) break;
      const remembered = lastChildRef.current[cur];
      const nxt = kids.find(k => k.id === remembered) ?? kids[0];
      lastChildRef.current[cur] = nxt.id;
      cur = nxt.id;
    }
    setSelectedNodeId(cur);
  }, [childrenOf, selectedNodeId, pauseFollowByUser]);

  // dir: -1=前の兄弟(↑) / +1=次の兄弟(↓)
  const navSibling = useCallback((dir) => {
    pauseFollowByUser();
    const p = parentOf(selectedNodeId);
    if (!p) return;
    const sibs = childrenOf(p);
    if (sibs.length <= 1) return;
    const idx = sibs.findIndex(s => s.id === selectedNodeId);
    const n = sibs.length;
    const target = sibs[(idx + dir + n) % n];
    lastChildRef.current[p] = target.id;
    setSelectedNodeId(target.id);
  }, [parentOf, childrenOf, selectedNodeId, pauseFollowByUser]);

  // キーボードで局面を前後移動（ボタンと同じ関数を呼ぶ）
  useEffect(() => {
    function onKey(e) {
      // ラベル・メモ編集中（入力欄フォーカス時）はキー操作を無視
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
        return;
      }
      switch (e.key) {
        // 論理移動：縦＝線を前後（↑親へ戻る／↓子へ進む）、横＝兄弟（分岐）の切替。
        // dagre の物理座標には依存しない。ガード（root で↑・末端で↓・兄弟1つで←→は
        // 何もしない）は nav 各関数側で実装済み。
        case 'ArrowUp': navPrev(); break;        // ↑ 一手戻る（親ノードへ）
        case 'ArrowDown': navNext(); break;      // ↓ 一手進む（子が複数なら本線へ）
        case 'ArrowLeft': navSibling(-1); break; // ← 前の分岐（兄弟）へ
        case 'ArrowRight': navSibling(1); break; // → 次の分岐（兄弟）へ
        case 'Home': navFirst(); break;
        case 'End': navLast(); break;
        default: return;
      }
      e.preventDefault(); // ページスクロール抑制
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navNext, navPrev, navSibling, navFirst, navLast]);

  // ボタンの有効/無効判定
  const navState = useMemo(() => {
    const parent = parentOf(selectedNodeId);
    const kids = childrenOf(selectedNodeId);
    const sibs = parent ? childrenOf(parent) : [];
    return {
      onFirst: navFirst, onPrev: navPrev, onNext: navNext, onLast: navLast,
      onUp: () => navSibling(-1), onDown: () => navSibling(1),
      canFirst: selectedNodeId !== ROOT_ID,
      canPrev: !!parent,
      canNext: kids.length > 0,
      canLast: kids.length > 0,
      canSibling: sibs.length > 1,
    };
  }, [parentOf, childrenOf, selectedNodeId, navFirst, navPrev, navNext, navLast, navSibling]);

  // ---- 評価値グラフ ----
  const [showGraph, setShowGraph] = useState(() => localStorage.getItem('shogi-show-graph') === '1');
  useEffect(() => { localStorage.setItem('shogi-show-graph', showGraph ? '1' : '0'); }, [showGraph]);

  // ---- ツリーパネルの表示/非表示（既定=表示）----
  // 非表示中もツリーデータ（nodes/edges）は App が保持しているため、
  // 盤面で指した手は記録され続け、キーボードナビも従来どおり機能する
  const [showTree, setShowTree] = useState(() => localStorage.getItem('shogi-show-tree') !== '0');
  useEffect(() => { localStorage.setItem('shogi-show-tree', showTree ? '1' : '0'); }, [showTree]);

  // ツリーOFF時のワイドレイアウトは 1200px 以上の画面のみ（未満は縦積みにフォールバック）
  const [vw, setVw] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const wideBoard = !showTree && vw >= 1200;

  // ---- 分岐比較（2ノードを選んで評価値推移を重ね描き）----
  const [compareA, setCompareA] = useState(null); // 変化A の nodeId
  const [compareB, setCompareB] = useState(null); // 変化B の nodeId
  const [showCompare, setShowCompare] = useState(false);

  const resetCompare = useCallback(() => {
    setCompareA(null); setCompareB(null); setShowCompare(false);
  }, []);

  // 比較ボタン：現在の選択ノードを A→B の順に取り込み、両方揃ったら比較を開く
  const pickCompare = useCallback(() => {
    if (showCompare) { resetCompare(); return; }
    if (compareA == null) { setCompareA(selectedNodeId); return; }
    if (selectedNodeId === compareA) return; // 同じノードは2つ目にできない
    setCompareB(selectedNodeId);
    setShowCompare(true);
  }, [showCompare, compareA, selectedNodeId, resetCompare]);

  // ルート→指定ノードのパス（nodeId 配列。root が先頭）
  const pathIds = useCallback((nodeId) => {
    const ids = [];
    const guard = new Set();
    let cur = nodeId;
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      ids.unshift(cur);
      cur = parentOf(cur);
    }
    return ids;
  }, [parentOf]);

  // 比較データ：2ラインと分岐点(共通の親)の手数
  // 削除等で対象ノードが消えたら null（→ CompareView は表示されず通常グラフに戻る）
  const compareData = useMemo(() => {
    if (!showCompare || compareA == null || compareB == null) return null;
    if (!nodes.some(n => n.id === compareA) || !nodes.some(n => n.id === compareB)) return null;
    const toLine = (nodeId) => pathIds(nodeId).map(id => {
      const n = nodes.find(x => x.id === id);
      return {
        nodeId: id,
        ply: n?.data.moves?.length ?? 0,
        cp: n?.data.eval ? n.data.eval.cp : null,
        isMate: n?.data.eval?.isMate ?? false,
      };
    });
    const idsA = pathIds(compareA);
    const idsB = pathIds(compareB);
    const setA = new Set(idsA);
    let lca = null;
    for (let i = idsB.length - 1; i >= 0; i--) {
      if (setA.has(idsB[i])) { lca = idsB[i]; break; }
    }
    const lcaNode = lca ? nodes.find(n => n.id === lca) : null;
    const divergePly = lcaNode ? (lcaNode.data.moves?.length ?? 0) : null;
    const labelOf = (id) => {
      const n = nodes.find(x => x.id === id);
      return n?.data.label ?? id;
    };
    return {
      lineA: toLine(compareA), lineB: toLine(compareB), divergePly,
      labelA: labelOf(compareA), labelB: labelOf(compareB),
    };
  }, [showCompare, compareA, compareB, nodes, pathIds]);

  // ルート→選択→（最後に訪れた子優先で）末端までの現在ライン
  const currentLine = useMemo(() => {
    const back = [];
    const guard = new Set();
    let cur = selectedNodeId;
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      const n = nodes.find(x => x.id === cur);
      if (!n) break;
      back.unshift(n);
      cur = parentOf(cur);
    }
    const fwd = [];
    const seen = new Set(back.map(n => n.id));
    let c = selectedNodeId;
    for (let i = 0; i < 2000; i++) {
      const kids = childrenOf(c);
      if (!kids.length) break;
      const remembered = lastChildRef.current[c];
      const nxt = kids.find(k => k.id === remembered) ?? kids[0];
      if (!nxt || seen.has(nxt.id)) break;
      seen.add(nxt.id);
      fwd.push(nxt);
      c = nxt.id;
    }
    return [...back, ...fwd].map(n => ({
      nodeId: n.id,
      ply: n.data.moves?.length ?? 0,
      cp: n.data.eval ? n.data.eval.cp : null,
      isMate: n.data.eval?.isMate ?? false,
      bestCp: n.data.eval?.bestCp ?? null,
    }));
  }, [nodes, selectedNodeId, parentOf, childrenOf]);

  // ---- 自動保存（localStorage、2秒デバウンス） ----
  const [restorePrompt, setRestorePrompt] = useState(null); // 起動時の復元確認データ
  const [restoreChecked, setRestoreChecked] = useState(false); // 復元確認が済むまで保存を抑止
  const [lastSaved, setLastSaved] = useState(null);
  const [saveError, setSaveError] = useState(false);
  const quotaAlertedRef = useRef(false);
  const selRef = useRef(selectedNodeId);
  selRef.current = selectedNodeId;
  const kifBaseNameRef = useRef(null); // KIF読み込み直後のエクスポート名に使う元ファイル名

  // 起動時：保存データがあれば復元確認、なければ自動保存を有効化
  useEffect(() => {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.nodes) && data.nodes.length && Array.isArray(data.edges)) {
          setRestorePrompt(data);
          return; // ユーザーの判断を待つ（勝手に復元しない）
        }
      }
    } catch { /* 破損データは無視 */ }
    setRestoreChecked(true);
  }, []);

  // 変更から2秒後にデバウンス保存
  useEffect(() => {
    if (!restoreChecked) return;
    const t = setTimeout(() => {
      try {
        const payload = JSON.stringify({
          nodes, edges, selectedNodeId: selRef.current, savedAt: Date.now(),
        });
        localStorage.setItem(AUTOSAVE_KEY, payload);
        setLastSaved(new Date());
        setSaveError(false);
      } catch (err) {
        setSaveError(true);
        if (!quotaAlertedRef.current) {
          quotaAlertedRef.current = true;
          alert('自動保存できません。JSONエクスポートで保存してください。');
        }
        console.warn('自動保存失敗:', err);
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [nodes, edges, restoreChecked]);

  function doRestore() {
    const data = restorePrompt;
    if (data) {
      setNodes(data.nodes);
      setEdges(data.edges);
      const sel = data.selectedNodeId && data.nodes.some(n => n.id === data.selectedNodeId)
        ? data.selectedNodeId
        : (data.nodes[0]?.id ?? ROOT_ID);
      setSelectedNodeId(sel);
    }
    setRestorePrompt(null);
    setRestoreChecked(true);
  }

  function startNew() {
    setRestorePrompt(null);
    setRestoreChecked(true);
  }

  // JSON エクスポート
  function exportJSON() {
    const blob = new Blob([JSON.stringify({ nodes, edges }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = buildExportName(nodes, edges, kifBaseNameRef.current);
    a.click();
    URL.revokeObjectURL(url);
  }

  // JSON インポート
  function importJSON(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.nodes && data.edges) {
          setNodes(data.nodes);
          setEdges(data.edges);
          setSelectedNodeId(data.nodes[0]?.id ?? ROOT_ID);
          kifBaseNameRef.current = null; // KIF由来ではなくなる
        }
      } catch {
        alert('JSONファイルの読み込みに失敗しました');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // KIF テキストからツリーを構築して読み込む（ファイル・サンプル共用）
  function loadKifText(text, baseName, { selectBlunderAfter = false } = {}) {
    const { moves, error } = parseKif(text);
    if (moves.length === 0) {
      alert('KIF読み込み失敗：' + (error ?? '指し手がありません'));
      return;
    }
    // エクスポート名用に元ファイル名（拡張子除く）を保持
    kifBaseNameRef.current = baseName;

    // ルート + 各手を縦一列に配置
    const newNodes = [{
      id: ROOT_ID,
      type: 'shogiNode',
      position: { x: 0, y: 0 },
      data: { label: '平手初期局面', moves: [] },
    }];
    const newEdges = [];
    let prevId = ROOT_ID;
    let cumMoves = [];
    moves.forEach((mv, i) => {
      cumMoves = [...cumMoves, mv.moveInfo];
      const id = uuidv4();
      newNodes.push({
        id,
        type: 'shogiNode',
        position: { x: 0, y: (i + 1) * 110 },
        data: { label: `${i + 1}. ${mv.label}`, moves: cumMoves },
      });
      newEdges.push({
        id: `e-${prevId}-${id}`,
        source: prevId,
        target: id,
        style: { stroke: '#8b5e3c', strokeWidth: 2 },
      });
      prevId = id;
    });

    setNodes(newNodes);
    setEdges(newEdges);
    setSelectedNodeId(prevId); // 最終局面を盤面に表示

    if (error) alert('一部のみ読み込みました：' + error);

    // 読み込み完了後、自動で全ノードを解析
    selectBlunderAfterRef.current = selectBlunderAfter;
    startBatch(newNodes);
  }

  // KIF 読み込み：本譜をルートから一本道のツリーとして構築
  async function importKIF(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    let text;
    try {
      text = await readKifFile(file);
    } catch {
      alert('KIFファイルの読み込みに失敗しました');
      return;
    }
    loadKifText(text, file.name.replace(/\.[^.]*$/, ''));
  }

  // ---- KIF貼り付け読み込み ----
  // クリップボード由来のテキストは UTF-8 扱いのため Shift_JIS 判定（readKifFile）は通さず、
  // 既存パーサ parseKif で事前検証してから共通後続処理 loadKifText に渡す。
  const [showPasteKif, setShowPasteKif] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState(null);

  function importKifFromPaste() {
    const { moves, error } = parseKif(pasteText);
    if (moves.length === 0) {
      // 失敗：モーダル内にエラー表示し、貼り付けテキストは保持する
      setPasteError('KIFを読み込めませんでした：' + (error ?? '指し手が見つかりません'));
      return;
    }
    // 成功：モーダルを閉じ、ファイル読み込みと同じ後続処理（ツリー構築→自動解析）
    setShowPasteKif(false);
    setPasteError(null);
    setPasteText('');
    loadKifText(pasteText, '貼り付け棋譜');
  }

  // サンプル棋譜（public/sample.kif）を読み込み、解析後に最初の疑問手へ移動
  async function loadSample() {
    try {
      const res = await fetch('/sample.kif');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      loadKifText(text, 'サンプル棋譜', { selectBlunderAfter: true });
    } catch (err) {
      alert('サンプル棋譜の読み込みに失敗しました: ' + err.message);
    }
  }

  // ---- 初回オンボーディング・ヘルプ ----
  const [showWelcome, setShowWelcome] = useState(
    () => !localStorage.getItem('shogi-welcome-seen'));
  const [showHelp, setShowHelp] = useState(false);
  const kifInputRef = useRef(null);

  function dismissWelcome() {
    localStorage.setItem('shogi-welcome-seen', '1');
    setShowWelcome(false);
  }

  // 盤面バッジ用：選択中ノードの疑問手情報（判定は既存の blunderMark を再利用）
  const boardBlunder = useMemo(() => {
    const n = nodes.find(x => x.id === selectedNodeId);
    if (!n) return null;
    const pid = edges.find(e => e.target === selectedNodeId)?.source;
    const parent = nodes.find(x => x.id === pid);
    const mark = blunderMark(n.data, parent?.data.eval ?? null);
    if (!mark) return null;
    const last = n.data.moves[n.data.moves.length - 1];
    return { mark, tox: last.tox, toy: last.toy };
  }, [nodes, edges, selectedNodeId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100dvh' }}>
      {/* ヘッダツールバー */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 16px', background: '#3a1a00', color: '#f5e6c8',
        fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
        borderBottom: '2px solid #8b5e3c', flexShrink: 0,
      }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 'bold', letterSpacing: 2 }}>
            将棋分岐ツリービューア
          </span>
          <span style={{ fontSize: 11, color: saveError ? '#ffb0a0' : '#c8b088' }}>
            {saveError
              ? '⚠ 自動保存できません'
              : lastSaved
              ? `保存済み ${fmtTime(lastSaved)}`
              : ''}
          </span>
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', position: 'relative' }}>
          <button
            onClick={() => setShowTree(v => !v)}
            style={{ ...toolbarBtn, background: showTree ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)' }}
            title="分岐ツリーパネルの表示切替（非表示中も手は記録されます）"
          >
            🌳 ツリー {showTree ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={() => setShowGraph(v => !v)}
            style={{ ...toolbarBtn, background: showGraph ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)' }}
            title="評価値グラフの表示切替"
          >
            📈 グラフ {showGraph ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={pickCompare}
            style={{ ...toolbarBtn, background: (showCompare || compareA != null) ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)' }}
            title={
              showCompare
                ? '比較を閉じる'
                : compareA != null
                ? '別のノードを選んでもう一度押すと比較開始'
                : '2つのノードの評価値推移を重ねて比較する'
            }
          >
            🔀 {showCompare ? '比較を閉じる' : compareA != null ? '2つ目を選択' : '比較'}
          </button>
          <label style={{ ...toolbarBtn, cursor: 'pointer' }}>
            KIF読み込み
            <input ref={kifInputRef} type="file" accept=".kif,.kifu,.txt" onChange={importKIF} style={{ display: 'none' }} />
          </label>
          <button
            onClick={() => { setPasteError(null); setShowPasteKif(true); }}
            style={toolbarBtn}
            title="コピーしたKIFテキストを直接貼り付けて読み込む"
          >
            KIF貼り付け
          </button>
          <button
            onClick={() => startBatch(nodes)}
            style={toolbarBtn}
            disabled={!!batch}
            title="全ノードをエンジンで解析"
          >
            棋譜解析
          </button>
          <button
            onClick={expandAllAuto}
            style={toolbarBtn}
            title="自動折りたたみ・最善手ラインの集約をすべて展開する（手動グループは維持）"
          >
            ⊟ すべて展開
          </button>
          <span style={{ position: 'relative' }}>
            <button
              onClick={() => setShowCollapseMenu(v => !v)}
              style={{ ...toolbarBtn, background: showCollapseMenu ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)' }}
              title="対象を選んで折りたたむ（機能19の自動折りたたみと同じ畳み方）"
            >
              ⊞ 折りたたむ
            </button>
            {showCollapseMenu && (
              <>
                <div
                  onClick={() => setShowCollapseMenu(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                />
                <div style={{
                  position: 'absolute', top: 34, left: 0, zIndex: 41, minWidth: 230,
                  background: '#fdf6e3', border: '1.5px solid #8b5e3c', borderRadius: 8,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.25)', overflow: 'hidden',
                  color: '#3a1a00',
                }}>
                  <div style={{
                    padding: '7px 12px', fontSize: 11, color: '#8b5e3c',
                    borderBottom: '1px solid #e8d5a3', background: '#f5e6c8',
                  }}>
                    折りたたむ対象を選ぶ
                  </div>
                  <button
                    onClick={() => setCollapsePlainChecked(v => !v)}
                    style={settingsToggleStyle}
                  >
                    <span style={{ fontSize: 13, color: '#3a1a00', fontWeight: 'bold' }}>
                      {collapsePlainChecked ? '☑' : '☐'} 平凡な手の連続
                    </span>
                    <span style={{ fontSize: 10, color: '#8b5e3c', marginLeft: 16 }}>
                      疑問手の前後1手を残して平凡手区間を集約
                    </span>
                  </button>
                  <button
                    onClick={() => setCollapseBestChecked(v => !v)}
                    style={settingsToggleStyle}
                  >
                    <span style={{ fontSize: 13, color: '#3a1a00', fontWeight: 'bold' }}>
                      {collapseBestChecked ? '☑' : '☐'} 最善手ブランチ
                    </span>
                    <span style={{ fontSize: 10, color: '#8b5e3c', marginLeft: 16 }}>
                      疑問手に付与された最善手ライン（2手以上）を集約
                    </span>
                  </button>
                  <button
                    onClick={collapseSelectedNow}
                    style={{
                      display: 'block', width: '100%', padding: '8px 12px',
                      border: 'none', cursor: 'pointer', background: '#f0e6d0',
                      fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
                      fontSize: 13, color: '#3a1a00', fontWeight: 'bold', textAlign: 'center',
                    }}
                  >
                    折りたたむ
                  </button>
                </div>
              </>
            )}
          </span>
          <button
            onClick={addBestBranchesNow}
            style={toolbarBtn}
            title="疑問手（?/??）の親局面から最善手の読み筋（最大5手）を枝として追加"
          >
            💡 最善手ブランチ
          </button>

          {/* 解析設定（歯車） */}
          <button
            onClick={() => setShowSettings(s => !s)}
            style={toolbarBtn}
            title="解析設定"
          >
            ⚙ {DEPTH_SHORT[analysisDepth]}
          </button>
          {showSettings && (
            <>
              <div
                onClick={() => setShowSettings(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 40 }}
              />
              <div style={{
                position: 'absolute', top: 34, right: 0, zIndex: 41, minWidth: 220,
                background: '#fdf6e3', border: '1.5px solid #8b5e3c', borderRadius: 8,
                boxShadow: '0 6px 20px rgba(0,0,0,0.25)', overflow: 'hidden',
                color: '#3a1a00',
              }}>
                <div style={{
                  padding: '7px 12px', fontSize: 11, color: '#8b5e3c',
                  borderBottom: '1px solid #e8d5a3', background: '#f5e6c8',
                }}>
                  解析の深さ（1局面あたり）
                </div>
                {DEPTH_OPTIONS.map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => { setAnalysisDepth(opt.key); setShowSettings(false); }}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                      width: '100%', padding: '8px 12px', border: 'none', cursor: 'pointer',
                      borderBottom: '1px solid #e8d5a3',
                      background: analysisDepth === opt.key ? '#f0e6d0' : 'transparent',
                      fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ fontSize: 13, color: '#3a1a00', fontWeight: 'bold' }}>
                      {analysisDepth === opt.key ? '● ' : '○ '}{opt.label}
                    </span>
                    <span style={{ fontSize: 10, color: '#8b5e3c', marginLeft: 16 }}>{opt.sub}</span>
                  </button>
                ))}

                <div style={{
                  padding: '7px 12px', fontSize: 11, color: '#8b5e3c',
                  borderBottom: '1px solid #e8d5a3', background: '#f5e6c8',
                }}>
                  解析後のツリー自動整理
                </div>
                <button
                  onClick={() => setAutoCollapseOn(v => !v)}
                  style={settingsToggleStyle}
                >
                  <span style={{ fontSize: 13, color: '#3a1a00', fontWeight: 'bold' }}>
                    {autoCollapseOn ? '☑' : '☐'} 解析後に自動折りたたみする
                  </span>
                  <span style={{ fontSize: 10, color: '#8b5e3c', marginLeft: 16 }}>
                    疑問手の前後1手を残して平凡手区間を集約
                  </span>
                </button>
                <button
                  onClick={() => setAutoBestOn(v => !v)}
                  style={settingsToggleStyle}
                >
                  <span style={{ fontSize: 13, color: '#3a1a00', fontWeight: 'bold' }}>
                    {autoBestOn ? '☑' : '☐'} 疑問手に最善手ブランチを追加する
                  </span>
                  <span style={{ fontSize: 10, color: '#8b5e3c', marginLeft: 16 }}>
                    最善手の読み筋（最大5手）を枝として付与（ノードが増えます）
                  </span>
                </button>
              </div>
            </>
          )}

          <button onClick={exportJSON} style={toolbarBtn}>JSONエクスポート</button>
          <label style={{ ...toolbarBtn, cursor: 'pointer' }}>
            JSONインポート
            <input type="file" accept=".json" onChange={importJSON} style={{ display: 'none' }} />
          </label>
          <button
            onClick={() => setShowHelp(v => !v)}
            style={{
              ...toolbarBtn, borderRadius: '50%', width: 26, height: 26, padding: 0,
              fontWeight: 'bold', fontSize: 14,
              background: showHelp ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)',
            }}
            title="ヘルプ"
          >
            ?
          </button>
        </div>
      </div>

      {/* メインエリア：将棋盤（左）＋ ツリー（右） */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* 将棋盤（＋評価値グラフ）。ツリー非表示時は全幅に広がる */}
        <div style={{
          width: showTree ? '50%' : '100%',
          borderRight: showTree ? '2px solid #8b5e3c' : 'none',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <ShogiBoard
              moveHistory={currentMoves}
              onMove={handleBoardMove}
              boardKey={selectedNodeId}
              nav={navState}
              onEval={handleEval}
              blunder={boardBlunder}
              wide={wideBoard}
              graphSlot={wideBoard && (showGraph || (showCompare && compareData)) ? (
                showCompare && compareData ? (
                  <CompareView
                    lineA={compareData.lineA}
                    lineB={compareData.lineB}
                    divergePly={compareData.divergePly}
                    labelA={compareData.labelA}
                    labelB={compareData.labelB}
                    onClose={resetCompare}
                  />
                ) : (
                  <EvalGraph
                    line={currentLine}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={handleNodeSelect}
                  />
                )
              ) : null}
            />
          </div>
          {/* 下部グラフ帯（ワイドモード時はサイドバーに移動するため出さない） */}
          {!wideBoard && (showGraph || (showCompare && compareData)) && (
            <div style={{
              height: 200, flexShrink: 0, borderTop: '2px solid #8b5e3c',
              background: '#fff8ec', padding: '5px 8px', boxSizing: 'border-box',
            }}>
              {showCompare && compareData ? (
                <CompareView
                  lineA={compareData.lineA}
                  lineB={compareData.lineB}
                  divergePly={compareData.divergePly}
                  labelA={compareData.labelA}
                  labelB={compareData.labelB}
                  onClose={resetCompare}
                />
              ) : (
                <EvalGraph
                  line={currentLine}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={handleNodeSelect}
                />
              )}
            </div>
          )}
        </div>

        {/* 分岐ツリー（トグルで非表示可。データは App が保持し続ける） */}
        {showTree && (
          <div style={{ width: '50%', overflow: 'hidden' }}>
            <ShogiTree
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              selectedNodeId={selectedNodeId}
              onNodeSelect={handleNodeSelect}
              setNodes={setNodes}
              setEdges={setEdges}
            />
          </div>
        )}
      </div>

      {/* 解析進捗オーバーレイ（バックグラウンド続行中は非表示） */}
      {batch && !batch.background && (
        <AnalysisOverlay
          batch={batch}
          onCancel={cancelBatchAnalysis}
          onBackground={() => setBatch(b => (b ? { ...b, background: true } : b))}
        />
      )}

      {/* 起動時の復元確認 */}
      {restorePrompt && (
        <RestorePrompt data={restorePrompt} onRestore={doRestore} onNew={startNew} />
      )}

      {/* 初回訪問時のウェルカムモーダル（復元確認より優先度低） */}
      {showWelcome && !restorePrompt && (
        <WelcomeModal
          onSample={() => { dismissWelcome(); loadSample(); }}
          onOwnKif={() => { dismissWelcome(); kifInputRef.current?.click(); }}
          onClose={dismissWelcome}
          onHelp={() => { dismissWelcome(); setShowHelp(true); }}
        />
      )}

      {/* ヘルプパネル */}
      {showHelp && <HelpPanel onClose={() => setShowHelp(false)} />}

      {/* KIF貼り付けモーダル */}
      {showPasteKif && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 66, background: 'rgba(30,16,4,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
          }}
          onClick={() => setShowPasteKif(false)}
        >
          <div
            style={{
              background: '#fdf6e3', border: '2px solid #8b5e3c', borderRadius: 12,
              padding: '22px 28px', width: 560, maxWidth: '92vw',
              boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize: 16, fontWeight: 'bold', color: '#3a1a00', marginBottom: 6 }}>
              KIFを貼り付けて読み込む
            </div>
            <div style={{ fontSize: 11, color: '#8b5e3c', marginBottom: 10 }}>
              将棋ウォーズ等の「棋譜をコピー」でコピーしたKIFテキストをそのまま貼り付けてください
            </div>
            <textarea
              value={pasteText}
              onChange={e => { setPasteText(e.target.value); setPasteError(null); }}
              rows={14}
              placeholder={'手合割：平手\n   1 ７六歩(77)\n   2 ３四歩(33)\n   ...'}
              autoFocus
              style={{
                width: '100%', boxSizing: 'border-box', resize: 'vertical',
                border: '1.5px solid #8b5e3c', borderRadius: 6, padding: '8px 10px',
                fontSize: 12, background: '#fffdf5', color: '#3a1a00',
                fontFamily: 'monospace', lineHeight: 1.5,
              }}
            />
            {pasteError && (
              <div style={{
                marginTop: 8, padding: '7px 12px', fontSize: 12,
                background: '#fdecea', color: '#b3231a',
                border: '1px solid #e5a09a', borderRadius: 6,
              }}>
                ⚠ {pasteError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
              <button
                onClick={() => setShowPasteKif(false)}
                style={{
                  padding: '8px 18px', fontSize: 13, cursor: 'pointer', borderRadius: 6,
                  background: '#f0e6d0', color: '#5c3317', border: '1.5px solid #8b5e3c',
                  fontFamily: 'inherit',
                }}
              >
                キャンセル
              </button>
              <button
                onClick={importKifFromPaste}
                style={{
                  padding: '8px 22px', fontSize: 13, fontWeight: 'bold', cursor: 'pointer',
                  borderRadius: 6, border: 'none', color: '#fff',
                  background: 'linear-gradient(135deg, #c8a96e, #a0784a)',
                  fontFamily: 'inherit',
                }}
              >
                読み込む
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 一時通知トースト */}
      {toast && (
        <div style={{
          position: 'fixed', top: 52, left: '50%', transform: 'translateX(-50%)',
          zIndex: 70, background: 'rgba(58,26,0,0.92)', color: '#f5e6c8',
          padding: '8px 20px', borderRadius: 8, fontSize: 13,
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
          fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
          pointerEvents: 'none',
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ---- 初回訪問時のウェルカムモーダル ----
function WelcomeModal({ onSample, onOwnKif, onClose, onHelp }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 65,
      background: 'rgba(30,16,4,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
    }}>
      <div style={{
        background: '#fdf6e3', border: '2px solid #8b5e3c', borderRadius: 14,
        padding: '30px 36px', maxWidth: 480, textAlign: 'center',
        boxShadow: '0 14px 44px rgba(0,0,0,0.4)',
      }}>
        <div style={{ fontSize: 21, fontWeight: 'bold', color: '#3a1a00', letterSpacing: 3, marginBottom: 16 }}>
          将棋分岐ツリービューア
        </div>
        <div style={{ fontSize: 13, color: '#5c3317', textAlign: 'left', lineHeight: 1.9, marginBottom: 22 }}>
          ・棋譜（KIF）を読み込むと、AIが全手を解析して評価値と疑問手（?/??）を表示します<br />
          ・盤面で手を指すと分岐が枝分かれし、変化を比較・整理できます<br />
          ・研究した内容はラベル・メモを付けて保存できます
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, alignItems: 'center' }}>
          <button onClick={onSample} style={{
            padding: '11px 30px', fontSize: 15, fontWeight: 'bold', cursor: 'pointer',
            background: 'linear-gradient(135deg, #c8a96e, #a0784a)', color: '#fff',
            border: 'none', borderRadius: 8, fontFamily: 'inherit',
            boxShadow: '0 3px 10px rgba(139,94,60,0.4)', minWidth: 240,
          }}>
            ▶ サンプル棋譜で試す
          </button>
          <button onClick={onOwnKif} style={{
            padding: '9px 26px', fontSize: 13, cursor: 'pointer',
            background: '#f0e6d0', color: '#5c3317',
            border: '1.5px solid #8b5e3c', borderRadius: 8, fontFamily: 'inherit', minWidth: 240,
          }}>
            自分の棋譜を読み込む
          </button>
          <button onClick={onClose} style={{
            padding: '6px 20px', fontSize: 12, cursor: 'pointer',
            background: 'none', color: '#8b5e3c',
            border: 'none', fontFamily: 'inherit', textDecoration: 'underline',
          }}>
            閉じる
          </button>
        </div>
        <div style={{ marginTop: 12, fontSize: 11 }}>
          <a
            onClick={onHelp}
            style={{ color: '#7a4a10', cursor: 'pointer', textDecoration: 'underline' }}
          >
            使い方の詳細（ヘルプ）を見る
          </a>
        </div>
      </div>
    </div>
  );
}

// ---- ヘルプパネル ----
function HelpPanel({ onClose }) {
  const h = { fontSize: 13, fontWeight: 'bold', color: '#3a1a00', margin: '14px 0 6px' };
  const p = { fontSize: 12, color: '#5c3317', lineHeight: 1.8, margin: 0 };
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 64,
        background: 'rgba(30,16,4,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#fdf6e3', border: '2px solid #8b5e3c', borderRadius: 12,
          padding: '22px 30px', maxWidth: 520, maxHeight: '80vh', overflowY: 'auto',
          boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 16, fontWeight: 'bold', color: '#3a1a00' }}>ヘルプ</span>
          <button onClick={onClose} style={{
            fontSize: 12, cursor: 'pointer', padding: '3px 12px',
            background: '#f0e6d0', color: '#5c3317',
            border: '1.5px solid #8b5e3c', borderRadius: 5, fontFamily: 'inherit',
          }}>
            閉じる
          </button>
        </div>

        <div style={h}>基本の流れ</div>
        <p style={p}>
          ① KIF読み込み（またはサンプル棋譜） → ② 棋譜解析（自動で始まります） →
          ③ ツリーの ? / ?? マークを探す → ④ その局面から盤面で別の手を指して分岐を作り、検討する
        </p>

        <div style={h}>キーボード操作</div>
        <p style={p}>
          ↓ 1手進む ／ ↑ 1手戻る ／ ←→ 分岐（兄弟ノード）の切り替え<br />
          Home 初期局面へ ／ End 現在の道の末端へ<br />
          Shift+クリック 複数ノード選択（右クリックでグループ化）
        </p>

        <div style={h}>各ボタンの説明</div>
        <p style={p}>
          📈 グラフ … 評価値の推移グラフを盤面下に表示<br />
          🔀 比較 … 2つのノードを順に選び、評価値推移を重ねて比較<br />
          棋譜解析 … 未解析の全ノードをエンジンで一括解析<br />
          ⊞ 整列 … ツリー全体を自動レイアウトに整える<br />
          ⇅ 反転 … 盤面を後手視点に180度回転<br />
          JSONエクスポート／インポート … 研究ツリーの保存と復元（手動バックアップ）<br />
          🗺 ミニマップ … ツリー全体の俯瞰図を右下に表示
        </p>

        <div style={h}>注意</div>
        <p style={p}>
          PC推奨。スマートフォンでは表示が崩れる場合があります。<br />
          作業内容は自動保存されます（ヘッダーに保存時刻を表示）。
        </p>

        <p style={{ ...p, marginTop: 14 }}>
          <a
            href="https://forms.gle/dCRn8L2AJcFGQwE49"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#5c3317' }}
          >
            ご意見・ご要望はこちら（1問だけの匿名フォームです）
          </a>
        </p>
      </div>
    </div>
  );
}

// ---- 前回作業の復元確認 ----
function RestorePrompt({ data, onRestore, onNew }) {
  const savedAt = data.savedAt ? new Date(data.savedAt) : null;
  const moveNodes = Math.max(0, (data.nodes?.length ?? 1) - 1);
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      background: 'rgba(30,16,4,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
    }}>
      <div style={{
        background: '#fdf6e3', border: '2px solid #8b5e3c', borderRadius: 12,
        padding: '26px 32px', minWidth: 360, textAlign: 'center',
        boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
      }}>
        <div style={{ fontSize: 17, fontWeight: 'bold', color: '#3a1a00', marginBottom: 8 }}>
          前回の作業を復元しますか？
        </div>
        <div style={{ fontSize: 12, color: '#8b5e3c', marginBottom: 22, lineHeight: 1.6 }}>
          自動保存されたツリー（{moveNodes} ノード）が見つかりました。<br />
          {savedAt && `保存日時：${savedAt.toLocaleString()}`}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button onClick={onRestore} style={{
            padding: '9px 22px', fontSize: 14, cursor: 'pointer', borderRadius: 6,
            background: 'linear-gradient(135deg, #c8a96e, #a0784a)', color: '#fff',
            border: 'none', fontFamily: 'inherit', fontWeight: 'bold',
          }}>
            復元する
          </button>
          <button onClick={onNew} style={{
            padding: '9px 22px', fontSize: 14, cursor: 'pointer', borderRadius: 6,
            background: '#f0e6d0', color: '#5c3317', border: '1.5px solid #8b5e3c',
            fontFamily: 'inherit',
          }}>
            新規で始める
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- 解析進捗オーバーレイ ----
function AnalysisOverlay({ batch, onCancel, onBackground }) {
  const { total, done, ms, depthKey } = batch;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const remaining = Math.max(0, total - done);
  const sec = Math.ceil((remaining * ms) / 1000);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      background: 'rgba(30,16,4,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
    }}>
      <div style={{
        background: '#fdf6e3', border: '2px solid #8b5e3c', borderRadius: 12,
        padding: '26px 32px', minWidth: 360, textAlign: 'center',
        boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
      }}>
        <div style={{ fontSize: 17, fontWeight: 'bold', color: '#3a1a00', marginBottom: 4 }}>
          棋譜を解析中…
        </div>
        <div style={{ fontSize: 12, color: '#8b5e3c', marginBottom: 16 }}>
          深さ設定：{DEPTH_SHORT[depthKey]}
        </div>

        {/* プログレスバー */}
        <div style={{
          height: 16, background: '#e8dcc0', borderRadius: 8, overflow: 'hidden',
          border: '1px solid #c8a96e',
        }}>
          <div style={{
            width: `${pct}%`, height: '100%',
            background: 'linear-gradient(90deg, #c8a96e, #8b5e3c)',
            transition: 'width 0.3s ease',
          }} />
        </div>
        <div style={{ fontSize: 14, color: '#3a1a00', margin: '10px 0 2px', fontWeight: 'bold' }}>
          {done} / {total}
        </div>
        <div style={{ fontSize: 12, color: '#8b5e3c', marginBottom: 20 }}>
          残り約 {sec} 秒
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button onClick={onBackground} style={{
            padding: '8px 18px', fontSize: 13, cursor: 'pointer', borderRadius: 6,
            background: 'linear-gradient(135deg, #c8a96e, #a0784a)', color: '#fff',
            border: 'none', fontFamily: 'inherit',
          }}>
            バックグラウンドで続行
          </button>
          <button onClick={onCancel} style={{
            padding: '8px 18px', fontSize: 13, cursor: 'pointer', borderRadius: 6,
            background: '#f0e6d0', color: '#8b3a1a', border: '1.5px solid #c0392b',
            fontFamily: 'inherit',
          }}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}

const settingsToggleStyle = {
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
  width: '100%', padding: '8px 12px', border: 'none', cursor: 'pointer',
  borderBottom: '1px solid #e8d5a3', background: 'transparent',
  fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif', textAlign: 'left',
};

const toolbarBtn = {
  padding: '5px 13px', background: 'rgba(255,255,255,0.12)',
  color: '#f5e6c8', border: '1px solid rgba(255,255,255,0.25)',
  borderRadius: 4, fontSize: 12, cursor: 'pointer',
  fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", serif',
};
