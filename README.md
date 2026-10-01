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
2. カレンダーから日付をタップし、担当2枠への参加/取消/交代リクエスト/欠席への変更ができます。
3. 日付詳細の「やることリスト」で、その日の掃除内容をチェックできます（「すべてチェック」「すべて解除」ボタンあり）。
4. 下部タブの「統計」で、当月・通算の担当回数を確認できます。
5. 右上の📲ボタンからスマホのホーム画面にアプリとして追加できます（アイコンをタップするだけでブラウザのURLバーなしで開けます）。
6. 右上の⚙️ボタンから、次の期（学期）の期間を設定できます（下記「次の期に切り替える」参照）。

## 通知機能（任意設定）

設定すると、以下のタイミングでLINEやDiscord/Slackに自動通知が届くようになります。**何も設定しなくてもアプリ自体は通常通り動作します。**

- 毎朝7:00（JST）: 本日の担当がまだ1人以下なら通知
- 毎晩19:00（JST）: 明日の担当がまだ1人以下なら通知
- 交代リクエストが送信された直後

通知先は以下のどちらか一方を設定してください（両方設定した場合はLINEが優先されます）。

### 方法A: Discord/Slackの Webhook（簡単）

DiscordやSlackのチャンネルで「Incoming Webhook」のURLを発行し、次のコマンドで登録します。

```bash
wrangler secret put NOTIFY_WEBHOOK_URL
```

実行するとURLの入力を求められるので、Webhook URLを貼り付けてEnterを押してください。

### 方法B: LINE Messaging API（グループに通知したい場合）

1. [LINE Developers](https://developers.line.biz/) で Messaging API チャンネルを作成し、「チャンネルアクセストークン」を発行する
2. 作ったLINE公式アカウントを通知したいグループ（またはトーク）に招待する
3. グループのトークID（`LINE_TARGET_ID`）を取得する（LINE Developersのコンソールや、Webhookログから確認できます。わからない場合は教えてください）
4. 以下を登録する

```bash
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
wrangler secret put LINE_TARGET_ID
```

## 管理機能（次の期に切り替える）

次の学期が始まるとき、コードを書き換えず、アプリの画面から対象期間を変更できます。

1. 管理パスワードを設定する（まだの場合）

```bash
wrangler secret put ADMIN_PASSWORD
```

2. アプリ右上の⚙️ボタンを開き、設定したパスワードと新しい期間（開始日・終了日・表示名）を入力して「この期間で切り替える」を押す

これまでの担当記録は消えません。統計の「通算」は新しい開始日以降のみを数えます。

## 更新したいとき

`public/index.html` や `src/worker.js` を編集後、再度下記を実行すれば反映されます（テーブル定義は変更していなければ3は不要です）。

```bash
git pull
wrangler d1 execute lab-cleaning-roster --remote --file=./schema.sql
wrangler deploy
```
