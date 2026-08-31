# Order System

文化祭などの模擬店で、注文受付・調理・受け渡し・お客様向け表示をリアルタイムに同期する注文管理システムです。販売や決済は扱わず、販売済みチケットの番号を受付時の照合キーとして利用します。

## 主な機能

- タッチ操作を前提とした受付・調理・受け渡し画面
- Durable Objectsによる重複のない調理注文割り当て
- WebSocketによる画面のリアルタイム更新
- PWAとIndexedDBを利用した一時的な通信断への対応
- 管理者・役割別端末認証、操作履歴、CSV出力
- 営業日、メニュー、選択肢、受付番号範囲の管理

## 技術構成

- Cloudflare Workers
- Cloudflare D1
- Cloudflare Durable Objects
- TypeScript
- Vitest
- Vanilla JavaScript PWA

詳しい構成は[アーキテクチャ設計](Docs/architecture.md)を参照してください。

## 必要な環境

- Node.js 20以降
- npm
- Cloudflareアカウント（リモート環境へデプロイする場合）

## ローカルでの起動

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run dev -- --ip 0.0.0.0
```

Wranglerが表示するURLをブラウザで開きます。初回管理者作成には、`.dev.vars` の `ADMIN_SETUP_TOKEN` に設定した値を使用します。`.dev.vars` はコミットしないでください。

ローカルD1へマイグレーションが必要な場合は、次を実行します。

```sh
npx wrangler d1 migrations apply DB --local --env=""
```

## 品質チェック

```sh
npm test
npm run typecheck
npm run deploy:dry
npm run check:startup
```

`npm run typecheck` は、検査前にWranglerからCloudflare Workersの型定義を自動生成します。

## Cloudflareへのデプロイ

`wrangler.jsonc` に含まれるD1設定はひな型です。自分のCloudflareアカウントでD1データベースを作成し、Wranglerが発行した `database_id` を設定してください。作成したD1データベースへマイグレーションを適用し、セットアップトークンをSecretとして登録してからデプロイします。

```sh
npx wrangler d1 migrations apply DB --remote --env=""
npx wrangler secret put ADMIN_SETUP_TOKEN --env=""
npx wrangler deploy --env=""
```

stagingを利用する場合は各コマンドに `--env staging` を指定してください。Cloudflare上のリソースを作成・変更するコマンドなので、対象アカウントと環境を確認してから実行してください。

本番用トークンや管理者資格情報をリポジトリへ保存しないでください。

## ドキュメント

- [アーキテクチャ](Docs/architecture.md)
- [API](Docs/api.md)
- [データベース](Docs/database.md)
- [注文フロー](Docs/order-flow.md)

## コントリビューションとセキュリティ

変更を提案する場合は[CONTRIBUTING.md](CONTRIBUTING.md)を、脆弱性を見つけた場合は[SECURITY.md](SECURITY.md)を参照してください。

## ライセンス

このソフトウェアは[MIT License](LICENSE)で公開されています。
