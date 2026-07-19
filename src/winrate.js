/**
 * winrate.js — 評価値→勝率変換と、勝率損失ベースの疑問手判定（純関数）。
 * 終盤の大きな評価値では cp 差の意味が変わるため、判定は勝率差で行う。
 */

/**
 * 評価値(cp・先手視点)を勝率(0..1・先手視点)に変換する。
 * 詰み（番兵値 ±99999）は 1.0 / 0.0。
 */
export function winRate(cp) {
  if (cp == null) return null;
  if (Math.abs(cp) >= 99999) return cp > 0 ? 1 : 0; // 詰み
  return 1 / (1 + Math.exp(-cp / 600));
}

/**
 * 手番を考慮した勝率損失。
 * cp: 指した後の評価値 / bestCp: 親局面の最善手（multipv=1）の評価値（ともに先手視点）。
 * 先手の手なら「最善の勝率 − 実際の勝率」、後手の手なら逆方向が損失。
 * 最善手を指した場合は cp ≒ bestCp となり損失 0。
 */
export function blunderLoss(cp, bestCp, isBlackMove) {
  if (cp == null || bestCp == null) return null;
  return isBlackMove ? winRate(bestCp) - winRate(cp) : winRate(cp) - winRate(bestCp);
}

/** 勝率損失 → バッジ。5%以上で「?」、15%以上で「??」 */
export function lossMark(loss) {
  if (loss == null) return null;
  if (loss >= 0.15) return '??';
  if (loss >= 0.05) return '?';
  return null;
}

/**
 * 疑問手判定（最善手からの勝率損失方式）。ツリー・盤面・グラフ・自動整理で共用。
 * 親局面の最善手評価値は data.eval.bestCp（保存済み）を優先し、
 * 無ければ親ノードの評価値（＝親局面の multipv=1 スコア）で代用する。
 * @returns '??' | '?' | null
 */
export function blunderMark(nodeData, parentEval) {
  const ev = nodeData?.eval;
  if (!ev || !Array.isArray(nodeData.moves) || nodeData.moves.length === 0) return null;
  const bestCp = ev.bestCp ?? parentEval?.cp ?? null;
  const isBlackMove = nodeData.moves.length % 2 === 1; // 奇数手目＝先手の手
  return lossMark(blunderLoss(ev.cp, bestCp, isBlackMove));
}
