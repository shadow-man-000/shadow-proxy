# proxy-uv

Ultraviolet + Epoxy + Wisp ベースのWebプロキシ。

## 起動
```bash
npm install
npm start          # http://localhost:8080
```
任意で `ACCESS_PASSWORD=xxxx npm start` とするとBasic認証がかかります。

## デプロイ
- Node.js 18+ が動くVPS / Render / Railway / Fly.io など (サーバーレスは不可: WebSocketが必要)
- Service WorkerのためHTTPS必須 (localhostは例外)
- 公開する場合はCloudflare等のレート制限やパスワード保護を推奨

## 構成
- `src/index.js` … Express + Wisp (WebSocket経由のTCP中継)
- `public/index.html` … ブラウザ風UI
- `public/sw.js` … Service Worker (リクエストを横取りして書き換え)
- `public/uv/uv.config.js` … Ultraviolet設定 (prefix・エンコード方式)

## 環境変数
| 名前 | 説明 |
|---|---|
| `ACCESS_PASSWORD` | ログインパスワード (必須推奨) |
| `ENTRY_PATH` | 秘密のログインURL (例 `/my-secret-door`。初期値 `/_login`) |
| `SESSION_SECRET` | 任意。設定すると再起動してもログイン状態が維持される |
| `MAX_CONNS` | Wispの同時接続数上限 (初期値 200) |

## 動作
- 未ログインの人が `/` を開くと、ふつうの個人ブログ風ページ(`decoy/index.html`)が表示される。他のパスは404。
- `https://ドメイン/ENTRY_PATH` でパスワードを入力するとプロキシ画面が使える。
- 未ログインのWebSocket接続・接続数上限超過は、理由を返さず切断する。
- ログインは5回失敗すると10分ブロックされる。
