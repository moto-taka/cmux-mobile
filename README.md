# cmux-mobile

スマホブラウザからcmuxワークスペースのターミナルにアクセスするモバイルWebアプリ。

## 必要条件

- Node.js 18+
- [cmux](https://cmux.com) が起動中でSocket APIが有効

> ターミナルは cmux の `mobile.terminal.*`（render-grid）を直接ミラーするため、**ttyd は不要**になりました。

## 使い方

### バックグラウンド起動（ターミナルを占有しない）

ターミナルを塞がずに常駐させたい場合はこちら。ターミナルを閉じても動き続けます。

```bash
npm run serve     # ビルドしてバックグラウンド起動（LAN限定）
# もしくは
npm run up        # 既存ビルドをバックグラウンド起動
npm run status    # 稼働状況とURLを表示
npm run url       # スマホ用URL + QRコードを表示
npm run down      # 停止
npm run restart   # 再起動
node bin/cmux-mobile.js logs -f   # ログ追尾
```

- アクセストークンは永続化されるため、**スマホのURLは再起動しても変わりません**（一度ブックマークすればOK）。
- バックグラウンド既定は **LAN限定**（公開トンネルなし）。公開したい場合は `npm run up -- --tunnel`。
- 状態・ログ: `~/.local/state/cmux-mobile/`, `~/Library/Logs/cmux-mobile.log`

### フォアグラウンド起動

```bash
# 開発モード（このターミナルを占有・Ctrl-Cで停止）
npx tsx src/server/index.ts start

# ビルドして実行
npm run build
npm start

# オプション指定（bin経由で有効）
node bin/cmux-mobile.js start --port 8080 --no-tunnel
```

スマホから `http://<PCのIP>:3456?token=<token>` にアクセス（`npm run url` でURL取得）。

## アーキテクチャ

```
スマホブラウザ (xterm.js + render-grid.js)
  │
  └─ HTTP :3456 ─→ Fastify Server
                     ├─ 静的ファイル配信 (HTML/CSS/JS)
                     ├─ WebSocket /ws (制御 + ターミナルフレーム)
                     └─ REST API /api/*

Fastify Server
  ├─ cmux-socket.ts ─→ Unix Socket (自動検出) ─→ cmux
  │     ├─ mobile.terminal.replay (render-grid をポーリング取得)
  │     └─ mobile.terminal.input  (入力送出 / viewportは送らない)
  └─ index.ts ─→ HTTP/WS サーバー / render-grid フレーム配信
```

ターミナル描画: サーバが `mobile.terminal.replay` で cmux の render-grid フレームを取得 →
クライアントが `renderGridToVT()` で VT バイトに変換し xterm.js に描画（スタイル/カーソル/
代替画面/スクロールバックを忠実再現）。

## UI

- **メイン画面**: 常にターミナル (xterm.js / cmux render-grid ミラー)
- **☰ ハンバーガー**: 左からサイドバーがスライドイン → ワークスペース一覧
  - ステータスドット (緑=idle, 黄=running, 赤=error)
  - git branch表示
  - タップでワークスペース切替
- **サーフェスタブ**: 複数ペインがある場合のみ表示
- **ℹ ボタン**: 下から情報パネル (cwd, branch, status, progress, log)
- **スワイプ**: 左スワイプでサイドバー閉じ

## 設定

| 環境変数 | デフォルト | 説明 |
|---------|-----------|------|
| `CMUX_SOCKET_PATH` | 自動検出 | cmuxソケットのパス（未指定なら `~/.local/state/cmux/last-socket-path` 等から自動検出） |

| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `--port` | 3456 | サーバーポート |
| `--host` | 0.0.0.0 | バインドホスト |
| `--socket-path` | 自動検出 | cmuxソケットパス |
| `--tunnel` / `--no-tunnel` | 起動方法による | 公開トンネル（`start`はON、`up`はOFF が既定） |

## リモートアクセス

Tailscale等で同一ネットワークに接続後、通常通りアクセス可能。

## テスト

```bash
npm test          # テスト実行
npm run typecheck # 型チェック
```
