/**
 * legality.js — 厳密合法手フィルタ。
 *
 * shogi.js の getMovesFrom / getDropsBy は疑似合法で「王手放置（自玉が
 * 相手の利きに入る手）」を除外しない（ライブラリ実装コメントに明記）。
 * 一方やねうら王は position コマンド内の違法手を
 * 「info string Error! : Illegal Input Move」として黙って無視し、その手前
 * の局面を解析する（Node上で実測済み）。この乖離が「盤面とエンジンの
 * 解析局面が食い違う」バグの根本原因のため、UI で指せる手を
 * 「自玉が取られない手」に限定してエンジン基準へ揃える。
 *
 * 既知の残課題：打ち歩詰め（エンジン側は違法）は判定コストが高いため
 * 未対応。通常の検討では実害が出にくい。
 */
import { Shogi } from 'shogi.js';

/** moveHistory を平手初期局面から厳密に再生した Shogi インスタンスを返す（違法手で throw） */
export function replayMoves(moveHistory) {
  const s = new Shogi();
  s.initialize({ preset: 'HIRATE' });
  for (const mv of moveHistory ?? []) {
    if (mv.type === 'move') s.move(mv.fromx, mv.fromy, mv.tox, mv.toy, mv.promote);
    else if (mv.type === 'drop') s.drop(mv.tox, mv.toy, mv.kind, mv.color);
  }
  return s;
}
const replay = replayMoves;

function findKing(s, color) {
  for (let x = 1; x <= 9; x++) {
    for (let y = 1; y <= 9; y++) {
      const p = s.get(x, y);
      if (p && p.kind === 'OU' && p.color === color) return { x, y };
    }
  }
  return null;
}

function isSquareAttacked(s, x, y, byColor) {
  for (let px = 1; px <= 9; px++) {
    for (let py = 1; py <= 9; py++) {
      const p = s.get(px, py);
      if (!p || p.color !== byColor) continue;
      if (s.getMovesFrom(px, py).some(m => m.to.x === x && m.to.y === y)) return true;
    }
  }
  return false;
}

/**
 * mv（moveInfo 形式）を指した後、自玉が相手の利きに入るなら true。
 * 王手の放置・自殺手・ピン駒の違法移動をまとめて検出する。
 * @param {object[]} moveHistory 現局面までの手順
 * @param {object} mv { type:'move', fromx,fromy,tox,toy,promote } | { type:'drop', tox,toy,kind }
 */
export function leavesKingInCheck(moveHistory, mv) {
  let s;
  try {
    s = replay(moveHistory);
    const color = s.turn;
    if (mv.type === 'drop') s.drop(mv.tox, mv.toy, mv.kind, color);
    else s.move(mv.fromx, mv.fromy, mv.tox, mv.toy, !!mv.promote);
    const king = findKing(s, color);
    if (!king) return false; // 玉のない検討用局面では制限しない
    return isSquareAttacked(s, king.x, king.y, color === 0 ? 1 : 0);
  } catch {
    return true; // 適用できない手は不許可（安全側）
  }
}
