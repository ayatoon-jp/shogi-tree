/**
 * treeLayout.js — dagre によるツリー自動レイアウト。
 * ノードのデータ構造には触れず position のみ差し替える。
 */
import dagre from 'dagre';

// React Flow が実測した width/height が乗る前のフォールバック寸法
const DEFAULT_SIZE = {
  shogiNode: { width: 120, height: 62 },
  groupNode: { width: 160, height: 100 },
};

function sizeOf(node) {
  const fallback = DEFAULT_SIZE[node.type] ?? DEFAULT_SIZE.shogiNode;
  return {
    width: node.width ?? fallback.width,
    height: node.height ?? fallback.height,
  };
}

/**
 * ツリー全体を上→下（TB）に整列した新しい nodes 配列を返す。
 * data・id・type は元のまま、position だけ更新する。
 */
export function layoutTree(nodes, edges) {
  if (!nodes.length) return nodes;

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'TB',
    nodesep: 50,  // 兄弟間の水平間隔（従来の手動オフセット180pxに近い密度）
    ranksep: 62,  // 親子間の垂直間隔（従来の +130px 相当）
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    g.setNode(n.id, sizeOf(n));
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  return nodes.map(n => {
    const p = g.node(n.id);
    if (!p) return n; // エッジ未接続などで dagre に載らなかったノードは現状維持
    const { width, height } = sizeOf(n);
    return {
      ...n,
      // dagre はノード中心座標を返す → React Flow は左上基準なので変換
      position: { x: p.x - width / 2, y: p.y - height / 2 },
    };
  });
}
