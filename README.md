/spawn-teamで並列作業すること
ローカルのcmuxを外出しても作業を続けられるmobileアプリ(tailscaleとかでweb経由でいい)を作りたい
https://cmux.com/ja/docs/getting-started のドキュメントをすべて読む
cmuxのUIを完全に理解する

ttydとかなにつかうかまで決めて実装まで完遂して。未定の箇所は全部決めていい
bestで変更につよく使いやすいを目指す

npx cmux-mobile start
  → Nodeサーバー起動
  → cmux socketからworkspace.list等を購読
  → 各workspaceにttydプロセスを立てる
  → このWebUIを配信
  → スマホから http://<IP>:3456 でアクセス
  
  メイン画面 = 常にターミナル。左上のハンバーガーメニューからサイドバーが左からスライドインして、ワークスペース一覧が出ます。各ワークスペースにはステータスドット・git branch・最新ログが表示され、タップで切り替わってサイドバーが閉じます。
  ペインの切り替えはヘッダー直下のタブ（surfaceが複数ある場合のみ表示）、サイドバー情報（cwd, status, progress, log）は右上の「ℹ」ボタンでトグルです。
