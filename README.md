# cmux-mobile

スマホブラウザからcmuxワークスペースのターミナルにアクセスするモバイルWebアプリ。

## 必要条件

- Node.js 18+
- [cmux](https://cmux.com) が起動中でSocket APIが有効
- ttyd (`brew install ttyd`)

## 使い方

```bash
# 開発モード
npx tsx src/server/index.ts start

# ビルドして実行
npm run build
npm start

# オプション指定
npx tsx src/server/index.ts start --port 8080 --socket-path /tmp/cmux.sock
```

スマホから `http://<PCのIP>:3456` にアクセス。

## アーキテクチャ

```
スマホブラウザ
  │
  ├─ HTTP :3456 ─→ Fastify Server
  │                  ├─ 静的ファイル配信 (HTML/CSS/JS)
  │                  ├─ WebSocket /ws (リアルタイム更新)
  │                  └─ REST API /api/*
  │
  └─ HTTP :9001+ ─→ ttyd (各workspaceのターミナル)
                      │
                      └─ bash (workspaceのcwd)

Fastify Server
  ├─ cmux-socket.ts ─→ Unix Socket (/tmp/cmux.sock) ─→ cmux
  ├─ ttyd-manager.ts ─→ ttydプロセス管理 (per workspace)
  └─ index.ts ─→ HTTP/WS サーバー
```

## UI

- **メイン画面**: 常にターミナル (ttyd iframe)
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
| `CMUX_SOCKET_PATH` | `/tmp/cmux.sock` | cmuxソケットのパス |

| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `--port` | 3456 | サーバーポート |
| `--host` | 0.0.0.0 | バインドホスト |
| `--socket-path` | `/tmp/cmux.sock` | cmuxソケットパス |
| `--ttyd-base-port` | 9001 | ttyd開始ポート |

## リモートアクセス

Tailscale等で同一ネットワークに接続後、通常通りアクセス可能。
