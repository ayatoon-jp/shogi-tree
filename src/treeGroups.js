/**
 * treeGroups.js — グループ化の純関数コアと、解析後のツリー自動整理。
 *
 * - collapseChain / expandGroupNode: ShogiTree の手動グループ化と同じ配線ロジック
 *   （ShogiTree からも利用され、実装は一本化されている）
 * - autoCollapse: 疑問手（?/??）とその前後1手を残し、分岐のない平凡手区間を
 *   自動で集約ノードにまとめる（data.auto='collapse'）
 * - addBestBranches: 疑問手ノードの親から、保存済みの読み筋（multipv=1 の PV）を
 *   最大5手の枝として追加し、折りたたんだ状態で付与する（data.auto='best'）。
 *   エンジンへの追加解析は行わない。
 *
 * 自動生成ノードもすべて通常の nodes/edges（plain object）なので、
 * JSON エクスポート/インポートでそのまま保存・復元される。
 */
import { v4 as uuidv4 } from 'uuid';
import { usiToMoveInfo } from './ShogiEngine.js';
import { blunderMark } from './winrate.js';
import { replayMoves } from './legality.js';

const ROOT_ID = 'root';
const KIND_KANJI = {
  FU: '歩', KY: '香', KE: '桂', GI: '銀', KI: '金', KA: '角', HI: '飛', OU: '玉',
  TO: 'と', NY: '杏', NK: '圭', NG: '全', UM: '馬', RY: '龍',
};
const ROW_KANJI = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

// ラベルから手数プレフィックス（例「12. 」）を除去
export function cleanLabel(s) {
  return String(s ?? '').replace(/^\d+\.\s*/, '').trim();
}

function edgeStyle() {
  return { stroke: '#8b5e3c', strokeWidth: 2 };
}

/**
 * 連続ノード列 chain（親→子の順・検証済み）を1つの集約ノードに置き換える。
 * ShogiTree の手動グループ化と同一の配線。
 * @param opts { label?, auto?: 'collapse'|'best' }
 */
export function collapseChain(nodes, edges, chain, opts = {}) {
  const chainSet = new Set(chain);
  const chainNodes = chain.map(id => nodes.find(n => n.id === id));
  const headNode = chainNodes[0];
  const tailNode = chainNodes[chainNodes.length - 1];

  const parentEdge = edges.find(e => e.target === headNode.id);
  const tailChildEdges = edges.filter(e => e.source === tailNode.id && !chainSet.has(e.target));
  const internalEdges = edges.filter(e => chainSet.has(e.source) && chainSet.has(e.target));

  const groupId = uuidv4();
  const label = opts.label ??
    `${cleanLabel(headNode.data.label)} 〜 ${cleanLabel(tailNode.data.label)}（${chain.length}手）`;
  const groupNode = {
    id: groupId,
    type: 'groupNode',
    position: { ...headNode.position },
    data: {
      label,
      memo: '',
      count: chain.length,
      moves: tailNode.data.moves ?? [], // 集約ノード選択時は末尾局面を表示
      ...(tailNode.data.eval ? { eval: tailNode.data.eval } : {}),
      ...(opts.auto ? { auto: opts.auto } : {}),
      group: {
        nodes: chainNodes,
        edges: internalEdges,
        headId: headNode.id,
        tailId: tailNode.id,
      },
    },
  };

  const newNodes = [...nodes.filter(n => !chainSet.has(n.id)), groupNode];
  const newEdges = [
    ...edges.filter(e => !chainSet.has(e.source) && !chainSet.has(e.target)),
    ...(parentEdge
      ? [{ ...parentEdge, id: `e-${parentEdge.source}-${groupId}`, target: groupId }]
      : []),
    ...tailChildEdges.map(ce => ({ ...ce, id: `e-${groupId}-${ce.target}`, source: groupId })),
  ];
  return { nodes: newNodes, edges: newEdges, groupId };
}

/** 集約ノードを展開して元のノード列に戻す（ShogiTree の展開と同一配線） */
export function expandGroupNode(nodes, edges, groupId) {
  const gnode = nodes.find(n => n.id === groupId);
  if (!gnode || gnode.type !== 'groupNode') return { nodes, edges, tailId: null };
  const g = gnode.data.group;
  const parentEdge = edges.find(e => e.target === groupId);
  const childEdges = edges.filter(e => e.source === groupId);

  const newNodes = [...nodes.filter(n => n.id !== groupId), ...g.nodes];
  const newEdges = [
    ...edges.filter(e => e.source !== groupId && e.target !== groupId),
    ...g.edges,
    ...(parentEdge
      ? [{ ...parentEdge, id: `e-${parentEdge.source}-${g.headId}`, target: g.headId }]
      : []),
    ...childEdges.map(ce => ({ ...ce, id: `e-${g.tailId}-${ce.target}`, source: g.tailId })),
  ];
  return { nodes: newNodes, edges: newEdges, tailId: g.tailId };
}

/** 自動生成（auto付き）の集約ノードをすべて展開する。手動グループは維持。 */
export function expandAutoGroups(nodes, edges) {
  let ns = nodes;
  let es = edges;
  for (;;) {
    const target = ns.find(n => n.type === 'groupNode' && n.data.auto);
    if (!target) break;
    const r = expandGroupNode(ns, es, target.id);
    ns = r.nodes;
    es = r.edges;
  }
  return { nodes: ns, edges: es };
}

function buildMaps(nodes, edges) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const parentOf = new Map(edges.map(e => [e.target, e.source]));
  const childrenOf = new Map();
  for (const e of edges) {
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source).push(e.target);
  }
  return { byId, parentOf, childrenOf };
}

/**
 * 解析後の自動折りたたみ。
 * ?/?? ノードとその前後1手は保護し、それ以外の「分岐のない連続した平凡手」を
 * data.auto='collapse' の集約ノードにまとめる。
 * @param extraProtectedIds 追加の保護ノードid（省略時は従来どおり）
 */
export function autoCollapse(nodes, edges, extraProtectedIds = []) {
  const { byId, parentOf, childrenOf } = buildMaps(nodes, edges);
  const evalOf = id => byId.get(id)?.data.eval ?? null;

  // 保護対象: 疑問手ノード＋その親＋その子（前後1手）
  const protectedIds = new Set(extraProtectedIds);
  for (const n of nodes) {
    if (n.type !== 'shogiNode') continue;
    if (blunderMark(n.data, evalOf(parentOf.get(n.id)))) {
      protectedIds.add(n.id);
      const p = parentOf.get(n.id);
      if (p) protectedIds.add(p);
      for (const c of childrenOf.get(n.id) ?? []) protectedIds.add(c);
    }
  }

  // 折りたたみ可能: 通常ノード・ルート以外・非保護・分岐なし（子は1つ以下）
  const eligible = (id) => {
    const n = byId.get(id);
    return !!n && n.type === 'shogiNode' && id !== ROOT_ID && !protectedIds.has(id)
      && (childrenOf.get(id)?.length ?? 0) <= 1;
  };

  // チェーン収集（親が不適格なノードを先頭に、一本道を下る）
  const chains = [];
  const visited = new Set();
  for (const n of nodes) {
    if (!eligible(n.id) || visited.has(n.id)) continue;
    const p = parentOf.get(n.id);
    if (p && eligible(p)) continue; // 先頭ではない（親側から辿られる）
    const chain = [];
    let cur = n.id;
    while (cur && eligible(cur) && !visited.has(cur)) {
      chain.push(cur);
      visited.add(cur);
      const kids = childrenOf.get(cur) ?? [];
      cur = kids.length === 1 ? kids[0] : null;
    }
    if (chain.length >= 2) chains.push(chain);
  }

  let ns = nodes;
  let es = edges;
  for (const chain of chains) {
    const r = collapseChain(ns, es, chain, { auto: 'collapse' });
    ns = r.nodes;
    es = r.edges;
  }
  return { nodes: ns, edges: es, changed: chains.length > 0 };
}

// 2つの指し手が同一か（App の sameMove と同義）
function sameMove(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'drop') return a.tox === b.tox && a.toy === b.toy && a.kind === b.kind;
  return a.fromx === b.fromx && a.fromy === b.fromy
    && a.tox === b.tox && a.toy === b.toy && !!a.promote === !!b.promote;
}

/** 指し手の表示ラベル（例: 2四歩成 / 4六角打） */
function moveText(mv, kind) {
  const suffix = mv.type === 'drop' ? '打' : (mv.promote ? '成' : '');
  return `${mv.tox}${ROW_KANJI[mv.toy]}${KIND_KANJI[kind] ?? kind}${suffix}`;
}

/**
 * 展開済みの「最善手ブランチ」のノード列を再特定する。
 * 判定は addBestBranches と同一基準の再利用：疑問手（blunderMark）ノードの兄弟のうち、
 * 親の保存済み PV（multipv=1）の先頭手と一致（sameMove）する枝を先頭に、
 * PV に沿った一本道（子が1つ）を辿る。
 * 既に auto='best' の集約ノードがある親、1手のみの最善手（data.auto='best' の
 * ラベル付きノード。グループ化対象外）はスキップする。
 * @returns チェーンの配列（各チェーンは親→子順のノードid配列・長さ2以上）
 */
export function findBestChains(nodes, edges, maxPlies = 5) {
  const { byId, parentOf, childrenOf } = buildMaps(nodes, edges);
  const lastOf = s => {
    const m = s.data.moves;
    return m && m.length ? m[m.length - 1] : null;
  };
  const chains = [];
  const used = new Set();

  for (const n of nodes) {
    if (n.type !== 'shogiNode') continue;
    const pid = parentOf.get(n.id);
    const parent = byId.get(pid);
    if (!parent) continue;
    if (!blunderMark(n.data, parent.data.eval ?? null)) continue;

    const pv = parent.data.eval?.pv;
    if (!pv || pv.length === 0) continue;
    const best0 = usiToMoveInfo(pv[0]);
    if (!best0) continue;

    const siblings = (childrenOf.get(pid) ?? []).map(id => byId.get(id)).filter(Boolean);
    if (siblings.some(s => s.type === 'groupNode' && s.data.auto === 'best')) continue;
    const head = siblings.find(s =>
      s.type === 'shogiNode' && s.id !== n.id && sameMove(lastOf(s), best0));
    if (!head || head.data.auto === 'best' || used.has(head.id)) continue;

    // PV に沿って一本道を辿る（分岐・不一致で打ち切り）
    const chain = [head.id];
    let cur = head;
    for (let i = 1; i < Math.min(maxPlies, pv.length); i++) {
      const kids = childrenOf.get(cur.id) ?? [];
      if (kids.length !== 1) break;
      const next = byId.get(kids[0]);
      if (!next || next.type !== 'shogiNode') break;
      const mv = usiToMoveInfo(pv[i]);
      if (!mv || !sameMove(lastOf(next), mv)) break;
      chain.push(next.id);
      cur = next;
    }
    if (chain.length >= 2) {
      chains.push(chain);
      for (const id of chain) used.add(id);
    }
  }
  return chains;
}

/**
 * findBestChains で特定した展開済み最善手ブランチを、addBestBranches と同じ
 * ラベル・auto='best' の集約ノードに畳み直す（collapseChain を再利用）。
 * @returns { nodes, edges, count }
 */
export function collapseBestChains(nodes, edges) {
  const chains = findBestChains(nodes, edges);
  let ns = nodes;
  let es = edges;
  for (const chain of chains) {
    const head = ns.find(x => x.id === chain[0]);
    const side = ((head.data.moves?.length ?? 1) - 1) % 2 === 0 ? '▲' : '△';
    const label = `最善手：${side}${cleanLabel(head.data.label)}（${chain.length}手）`;
    const r = collapseChain(ns, es, chain, { label, auto: 'best' });
    ns = r.nodes;
    es = r.edges;
  }
  return { nodes: ns, edges: es, count: chains.length };
}

/**
 * 疑問手ノードの親から、保存済み PV（multipv=1 の読み筋）の先頭最大 maxPlies 手を
 * 「最善手ブランチ」として追加し、折りたたんだ状態で付与する。
 * 評価値は親の解析結果（cp）をそのまま付与（追加解析なし）。
 * @returns { nodes, edges, added }
 */
export function addBestBranches(nodes, edges, maxPlies = 5) {
  const { byId, parentOf, childrenOf } = buildMaps(nodes, edges);
  let ns = nodes;
  let es = edges;
  let added = 0;

  for (const n of nodes) {
    if (n.type !== 'shogiNode') continue;
    const pid = parentOf.get(n.id);
    const parent = byId.get(pid);
    if (!parent) continue;
    if (!blunderMark(n.data, parent.data.eval ?? null)) continue;

    const pEval = parent.data.eval;
    const pv = pEval?.pv;
    if (!pv || pv.length === 0) continue; // PV 未保存（旧データ）はスキップ

    // 既に最善手ブランチ追加済み、または最善手と同じ手の子が既にあるならスキップ
    const parentMoves = parent.data.moves ?? [];
    const best0 = usiToMoveInfo(pv[0]);
    if (!best0) continue;
    if (best0.type === 'drop') best0.color = parentMoves.length % 2; // 手番の色
    const siblings = (childrenOf.get(pid) ?? []).map(id => byId.get(id)).filter(Boolean);
    if (siblings.some(s => s.type === 'groupNode' && s.data.auto === 'best')) continue;
    const lastOf = s => {
      const m = s.data.moves;
      return m && m.length ? m[m.length - 1] : null;
    };
    if (siblings.some(s => sameMove(lastOf(s), best0))) continue;

    // PV を再生しながらノード列を構築（違法・不整合で安全に打ち切り）
    let sim;
    try { sim = replayMoves(parentMoves); } catch { continue; }
    const branchNodes = [];
    let cumMoves = parentMoves;
    for (let i = 0; i < Math.min(maxPlies, pv.length); i++) {
      const mv = usiToMoveInfo(pv[i]);
      if (!mv) break;
      let kind;
      try {
        if (mv.type === 'drop') {
          kind = mv.kind;
          mv.color = sim.turn;
          sim.drop(mv.tox, mv.toy, mv.kind, sim.turn);
        } else {
          kind = sim.get(mv.fromx, mv.fromy)?.kind;
          sim.move(mv.fromx, mv.fromy, mv.tox, mv.toy, mv.promote);
        }
      } catch {
        break;
      }
      cumMoves = [...cumMoves, mv];
      branchNodes.push({
        id: uuidv4(),
        type: 'shogiNode',
        position: { x: parent.position.x + 220, y: parent.position.y + 130 * (i + 1) },
        data: {
          label: moveText(mv, kind),
          moves: cumMoves,
          // 評価値は親局面の最善手評価（multipv=1）をそのまま付与。
          // bestCp=cp なので損失0＝バッジは付かない。
          eval: { cp: pEval.cp, depth: pEval.depth, isMate: !!pEval.isMate, bestCp: pEval.cp },
        },
      });
    }
    if (branchNodes.length === 0) continue;

    // 親→枝先頭のエッジと枝内部エッジを張る
    const branchEdges = [];
    let prev = pid;
    for (const bn of branchNodes) {
      branchEdges.push({ id: `e-${prev}-${bn.id}`, source: prev, target: bn.id, style: edgeStyle() });
      prev = bn.id;
    }
    ns = [...ns, ...branchNodes];
    es = [...es, ...branchEdges];

    // 折りたたんだ状態で付与（1手だけの枝はそのまま）
    const side = parentMoves.length % 2 === 0 ? '▲' : '△';
    const label = `最善手：${side}${branchNodes[0].data.label}（${branchNodes.length}手）`;
    if (branchNodes.length >= 2) {
      const r = collapseChain(ns, es, branchNodes.map(b => b.id), { label, auto: 'best' });
      ns = r.nodes;
      es = r.edges;
    } else {
      // 1手のみ: ラベルだけ最善手表記にする
      ns = ns.map(x => x.id === branchNodes[0].id
        ? { ...x, data: { ...x.data, label: `最善手：${side}${x.data.label}`, auto: 'best' } }
        : x);
    }
    added++;
  }
  return { nodes: ns, edges: es, added };
}
