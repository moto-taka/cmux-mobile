# cmux-mobile

スマホブラウザからcmuxワークスペースのターミナルにアクセスするモバイルWebアプリ。

## 必要条件

- Node.js 18+
- [cmux](https://cmux.com) が起動中でSocket APIが有効
- 外出先（別ネットワーク）のスマホから使うなら [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)（`brew install cloudflared`）。LAN内だけなら不要。

> ターミナルは cmux の `mobile.terminal.*`（render-grid）を直接ミラーするため、**ttyd は不要**になりました。

## 使い方

### ダブルクリックで起動（.app ランチャー）

ターミナルを一切開かずに起動したい場合は、ランチャーアプリを一度ビルドします。

```bash
npm run build:app    # ~/Applications/cmux-mobile.app を生成
```

`~/Applications/cmux-mobile.app` を **Finder / Launchpad からダブルクリック**するだけでバックグラウンド起動し、**QRコード画像がPreviewで開きます**（スマホのカメラでスキャンして接続）。URLもクリップボードにコピーされます。もう一度ダブルクリックすると「Stop / Show QR」を選べます（トグル）。

QRが符号化するのは **LAN URL**（同じWi-Fi用、実Wi-FiインターフェースのIPを自動選択）です。外出先から使いたい場合は下の `--tunnel` を参照。

> Node のバージョンを変えたりリポジトリを移動したら `npm run build:app` を再実行してください（node とパスを埋め込むため）。初回起動時は通知/オートメーションの許可を求められます。

### バックグラウンド起動（ターミナルを占有しない）

CLIから常駐させたい場合はこちら。ターミナルを閉じても動き続けます。

```bash
npm run serve     # ビルドしてバックグラウンド起動（LAN／同じWi-Fi）
# もしくは
npm run up        # 既存ビルドをバックグラウンド起動
npm run status    # 稼働状況とURLを表示
npm run url       # スマホ用URL + QR（ターミナル表示）
node bin/cmux-mobile.js qr --open   # QR画像を生成してPreviewで開く
npm run down      # 停止
npm run restart   # 再起動
node bin/cmux-mobile.js logs -f   # ログ追尾
```

- バックグラウンド既定は **LAN（同じWi-Fi）**。トークンは永続化されURLは固定（一度ブックマークすればOK）。複数のIPがあっても**デフォルトルートの実Wi-Fi IPを自動で先頭**に選びます。
- 外出先から使うなら `npm run up -- --tunnel`（Cloudflare quick tunnel）。ただし**到達確認できた時だけQRに採用**し、ダメなら自動でLANにフォールバックします（ネットワークによりトンネルは不安定。⚠ 公開URL＋トークンを知る人は端末にアクセス可）。スマホがTailscaleなら Tailscale IP のURLが確実です。
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
