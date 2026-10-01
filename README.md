# 掃除当番カレンダー

研究室の平日掃除当番を、メンバーが立候補制で登録・管理するアプリです。

- `artifact/` — Claude Artifact版（Claude.aiアカウントでのログインが必要）
- `public/`, `src/`, `wrangler.toml`, `schema.sql` — Cloudflare Workers + D1版（**アカウント不要**、名前を選ぶだけで使えます）

このREADMEはCloudflare版のデプロイ手順です。

## 必要なもの

- Node.js（ https://nodejs.org からインストール）
- 無料のCloudflareアカウント（ https://dash.cloudflare.com/sign-up ）

## デプロイ手順

リポジトリのルートで実行してください。

```bash
# 1. wrangler (Cloudflareのデプロイツール) をインストール
npm install -g wrangler

# 2. Cloudflareにログイン（ブラウザが開きます）
wrangler login

# 3. データベース(D1)を作成
wrangler d1 create lab-cleaning-roster
```

3のコマンドを実行すると、以下のような出力が出ます。

```
[[d1_databases]]
binding = "DB"
database_name = "lab-cleaning-roster"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

この `database_id` の値をコピーし、`wrangler.toml` の `REPLACE_WITH_YOUR_DATABASE_ID` の部分を書き換えてください。

```bash
# 4. テーブルを作成
wrangler d1 execute lab-cleaning-roster --remote --file=./schema.sql

# 5. デプロイ
wrangler deploy
```

デプロイが終わると `https://lab-cleaning-roster.<あなたのサブドメイン>.workers.dev` のようなURLが発行されます。これを研究室メンバーに共有してください。

## 使い方

1. 初回アクセス時、10人の名前から自分の名前を選びます（端末に自動で記憶され、次回から自動ログイン）。
2. カレンダー（平日のみ、2026/10〜2027/3）から日付をタップし、担当2枠への参加/取消/交代リクエスト/欠席への変更ができます。
3. 日付詳細の「やることリスト」で、その日の掃除内容をチェックできます（「すべてチェック」「すべて解除」ボタンあり）。
4. 下部タブの「統計」で、当月・通算の担当回数を確認できます。

## 更新したいとき

`public/index.html` や `src/worker.js` を編集後、再度 `wrangler deploy` を実行すれば反映されます。
