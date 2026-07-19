# 将棋分岐ツリービューア（shogi-tree）

**公開版：https://shogi-tree.vercel.app**

将棋の局面をツリー状に分岐させながら検討できる Web アプリ。
やねうら王（WebAssembly版）によるエンジン解析・評価値グラフ・候補手表示・KIF読み込みに対応。

## 主な機能

- 盤面操作（合法手ハイライト・成り確認・持ち駒）と分岐ツリーの双方向同期
- やねうら王 NNUE K-P による局面解析（評価値バー・候補手上位3・最善手ハイライト）
- KIF 形式の棋譜読み込み（Shift_JIS 自動判定）と自動棋譜解析
- 評価値グラフ・疑問手（?/??）マーキング・ノードのグループ化とメモ
- キーボード / ボタンによる局面ナビゲーション、ミニマップ
- JSON エクスポート / インポート、localStorage への自動保存
- KIF テキストの貼り付け読み込み（将棋ウォーズ等の「棋譜をコピー」に対応）
- 解析中に盤面が解析対象の局面へ自動追従
- 解析後のツリー自動折りたたみ（対象を選んで再折りたたみ可能）

## 動作環境

- SharedArrayBuffer を利用するため、配信時に以下の HTTP ヘッダが必要です：
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
- 開発時は `vite.config.js`、本番（Vercel）は `vercel.json` で設定済み

## 開発

```bash
npm install
npm run dev    # 開発サーバー
npm run build  # 本番ビルド
```

## ライセンス

本アプリケーションのソースコードは **GNU General Public License v3.0**（[LICENSE](./LICENSE)）で公開しています。
ソースコードはこのリポジトリから入手できます。

## クレジット・依存ライブラリ

本アプリは以下のソフトウェアを利用しています。各作者に感謝します。

| ソフトウェア | 作者 | ライセンス |
|---|---|---|
| [やねうら王](https://github.com/yaneurao/YaneuraOu)（将棋エンジン本体） | yaneurao 氏 | GPL-3.0 |
| 評価関数 SuishoPetite（水匠） | たややん 氏 | やねうら王に同梱 |
| [YaneuraOu.wasm / @mizarjp/yaneuraou.k-p](https://github.com/mizar/YaneuraOu.wasm)（WebAssembly 移植） | Mizar 氏 | GPL-3.0 |
| [shogi.js](https://github.com/na2hiro/Shogi.js)（将棋ロジック） | na2hiro 氏 | MIT |
| [React](https://react.dev/) | Meta Platforms, Inc. | MIT |
| [React Flow](https://reactflow.dev/)（ツリー描画） | webkid GmbH | MIT |
| [uuid](https://github.com/uuidjs/uuid) | uuid contributors | MIT |

やねうら王および WASM 移植版のソースコードは上記リンク先の各リポジトリから入手できます。
