# Contributing

IssueやPull Requestを歓迎します。大きな仕様変更は、実装前にIssueで目的と影響範囲を共有してください。

## 開発手順

1. リポジトリをforkまたはcloneします。
2. `main` から内容が分かる名前の作業ブランチを作成します。
3. `npm ci` で依存関係を導入します。
4. 変更に対応するテストを追加または更新します。
5. `npm test`、`npm run typecheck`、`npm run deploy:dry` を実行します。
6. 変更内容、理由、確認方法をPull Requestに記載します。

既存の設計、API互換性、利用者のデータを尊重してください。秘密情報、実環境のID、管理者資格情報、生成物はコミットしないでください。
