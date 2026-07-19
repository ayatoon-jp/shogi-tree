/**
 * kif.js — KIF 形式（将棋ウォーズ・81Dojo・Kifu for Windows 等）の棋譜パーサー。
 * 本譜のみ対応（変化＝分岐は無視）。コメント(*)・ヘッダー行は読み飛ばす。
 *
 * 座標系は shogi.js に合わせる:
 *   x = 筋（1〜9, 右→左）, y = 段（1〜9, 上→下）
 *   KIF の「７六」= x7 y6、着手元 (77) = fromx7 fromy7
 */
import { Shogi } from 'shogi.js';

// 筋（全角優先・半角も許容）
const FILE = {
  '１': 1, '２': 2, '３': 3, '４': 4, '５': 5, '６': 6, '７': 7, '８': 8, '９': 9,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
};
// 段（漢数字）
const RANK = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
};
// 駒（基本）
const PIECE = {
  '歩': 'FU', '香': 'KY', '桂': 'KE', '銀': 'GI', '金': 'KI', '角': 'KA', '飛': 'HI',
  '玉': 'OU', '王': 'OU', 'と': 'TO', '馬': 'UM', '龍': 'RY', '竜': 'RY',
};

// 終局・区切りキーワード（この手で打ち切り）
const TERMINATORS = /^(投了|中断|千日手|持将棋|詰み|不詰|反則勝ち|反則負け|反則|入玉勝ち|入玉|切れ負け|時間切れ|封じ手|まで)/;

/**
 * 指し手トークン（時刻括弧を除去済み）を解析。
 * 例: '７六歩(77)' / '同　歩(78)' / '５六歩打' / '２二角成(88)' / '５四成銀(45)'
 * @returns null | { drop, tox, toy, fromx?, fromy?, kind?, promote }
 */
function parseMoveToken(token, lastTo) {
  let s = token;
  let tox, toy;

  // 着手先
  if (s[0] === '同') {
    if (!lastTo) return null;
    tox = lastTo.x;
    toy = lastTo.y;
    s = s.slice(1).replace(/^[ 　]+/, ''); // 「同」と後続空白を除去
  } else {
    const fx = FILE[s[0]];
    const ry = RANK[s[1]];
    if (!fx || !ry) return null;
    tox = fx;
    toy = ry;
    s = s.slice(2);
  }

  // 着手元 (XY)（末尾）
  let fromx = null;
  let fromy = null;
  const om = s.match(/\((\d)(\d)\)\s*$/);
  if (om) {
    fromx = parseInt(om[1], 10);
    fromy = parseInt(om[2], 10);
    s = s.slice(0, om.index);
  }

  // 駒種（成香・成桂・成銀は2文字なので先にマッチ）
  s = s.trim();
  let kind = null;
  if (s.startsWith('成香')) { kind = 'NY'; s = s.slice(2); }
  else if (s.startsWith('成桂')) { kind = 'NK'; s = s.slice(2); }
  else if (s.startsWith('成銀')) { kind = 'NG'; s = s.slice(2); }
  else { kind = PIECE[s[0]]; s = s.slice(1); }
  if (!kind) return null;

  // 修飾（成 / 不成 / 打）
  const rest = s.trim();
  const promote = rest === '成';

  if (fromx === null) {
    // 着手元なし → 打（持ち駒を打つ）
    return { drop: true, tox, toy, kind, promote: false };
  }
  return { drop: false, tox, toy, fromx, fromy, promote };
}

/**
 * KIF テキストを解析して指し手配列を返す。
 * @returns {{ moves: {moveInfo:object, label:string}[], error: string|null }}
 */
export function parseKif(text) {
  const s = new Shogi();
  s.initialize({ preset: 'HIRATE' });

  const moves = [];
  let lastTo = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('*') || line.startsWith('#')) continue; // コメント
    if (line.startsWith('変化')) break;                          // 変化＝分岐は本譜のみ対応のため打ち切り

    // 手合割：平手以外は初期局面が異なるため未対応
    if (line.startsWith('手合割')) {
      if (!/平手/.test(line)) {
        return { moves: [], error: '平手以外の手合割は未対応です' };
      }
      continue;
    }

    // 指し手行は「数字 + 指し手」で始まる（ヘッダー行はここで弾かれる）
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;

    // 末尾の消費時間括弧（: や / を含む）を除去
    let body = m[2].replace(/[ 　]*\([^)]*[:：/][^)]*\)[ 　]*$/, '').trim();
    if (!body) continue;
    if (TERMINATORS.test(body)) break;

    const parsed = parseMoveToken(body, lastTo);
    if (!parsed) {
      return { moves, error: `解析できない指し手: 「${body}」` };
    }

    try {
      let moveInfo;
      if (parsed.drop) {
        const color = s.turn; // 0=先手 1=後手
        s.drop(parsed.tox, parsed.toy, parsed.kind, color);
        moveInfo = { type: 'drop', tox: parsed.tox, toy: parsed.toy, kind: parsed.kind, color };
      } else {
        s.move(parsed.fromx, parsed.fromy, parsed.tox, parsed.toy, parsed.promote);
        moveInfo = {
          type: 'move',
          fromx: parsed.fromx, fromy: parsed.fromy,
          tox: parsed.tox, toy: parsed.toy,
          promote: parsed.promote,
        };
      }
      const label = body.replace(/\(\d\d\)\s*$/, '').replace(/[ 　]+/g, '');
      moves.push({ moveInfo, label });
      lastTo = { x: parsed.tox, y: parsed.toy };
    } catch (err) {
      return { moves, error: `不正な手順: 「${body}」（${err?.message ?? err}）` };
    }
  }

  return {
    moves,
    error: moves.length === 0 ? '指し手が見つかりませんでした' : null,
  };
}

/**
 * File を読み込み、UTF-8 / Shift_JIS を自動判定してテキスト化する。
 * KIF は Shift_JIS で書き出されることが多い。
 */
export function readKifFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const buf = ev.target.result;
      let txt = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      // UTF-8 として不正（置換文字が出る）なら Shift_JIS とみなす
      if (txt.includes('�')) {
        try {
          txt = new TextDecoder('shift_jis').decode(buf);
        } catch {
          /* shift_jis 非対応環境ではそのまま */
        }
      }
      resolve(txt);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}
