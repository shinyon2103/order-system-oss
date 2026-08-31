# データベース設計（D1）

## 1. 方針

Cloudflare D1を注文データの正本とする。Durable Objectは競合制御とリアルタイム接続を担当し、重要な業務状態をメモリだけに保持しない。

初期版はこのクラスの模擬店における1つの論理的な営業日を単位に注文を管理する。GitHub上で複数の模擬店を管理することや、複数組織向けのマルチテナント化は対象外とする。`event_id` は同じクラスで複数の営業日を扱うための内部識別子として使用する。

## 2. エンティティ

```text
events 1 ─── N orders 1 ─── N order_items
                    │
                    ├── N order_status_history
                    └── 0..1 device_assignments

events 1 ─── N devices
menu_items 1 ─── N menu_option_groups 1 ─── N menu_options
admins 1 ─── N admin_sessions
```

## 3. `events`

営業日・開催単位を表す。

| 列 | 型 | 制約・用途 |
| --- | --- | --- |
| `id` | TEXT | UUID、主キー |
| `name` | TEXT | 表示名 |
| `business_date` | TEXT | `YYYY-MM-DD`、表示・集計用 |
| `status` | TEXT | `DRAFT` / `OPEN` / `CLOSED` |
| `online_next_number` | INTEGER NULL | この営業日を再開した際に復元するオンライン次番号 |
| `offline_next_number` | INTEGER NULL | この営業日を再開した際に復元するオフライン次番号 |
| `created_at` | TEXT | ISO 8601 UTC |
| `updated_at` | TEXT | ISO 8601 UTC |

## 4. `orders`

| 列 | 型 | 制約・用途 |
| --- | --- | --- |
| `id` | TEXT | UUID、主キー |
| `event_id` | TEXT | `events.id` |
| `ticket_number` | TEXT | 受付番号。同じ番号の複数注文を許可 |
| `status` | TEXT | 状態遷移資料の値域 |
| `accepted_at` | TEXT | キュー順序の基準。オンラインはWorker受信時刻、オフラインはサーバー時計へ補正した受付確定時刻（異常値はWorker受信時刻へ補正） |
| `created_at` | TEXT | サーバーが登録した時刻 |
| `cooking_started_at` | TEXT NULL | 調理開始時刻 |
| `ready_at` | TEXT NULL | 調理完了時刻 |
| `completed_at` | TEXT NULL | 提供時刻 |
| `assigned_device_id` | TEXT NULL | 調理端末 |
| `updated_at` | TEXT | 最終更新時刻 |
| `request_id` | TEXT | 受付再送防止用の冪等性キー |

推奨インデックスは次のとおり。

- `(event_id, status, accepted_at, id)`：最古の待機注文取得と状態別一覧
- `(event_id, ticket_number, created_at)`：受付番号による照合
- `(event_id, status, assigned_device_id, cooking_started_at, id)`：調理端末の担当注文復元
- `(event_id, assigned_device_id, ready_at)`：調理端末の公平割り当て
- オンライン注文は `allocate_online_order_number` トリガーが注文挿入と同じトランザクション内で番号を確定し、同一`request_id`の同時再送で番号を余分に消費しない。
- `(event_id, updated_at)`：管理画面の増分取得候補
- `(event_id, request_id)`：受付再送防止

`created_at` が同一になる可能性があるため、キュー順序は `created_at ASC, id ASC` とする。

## 5. `order_items`

注文の明細を正規化して保持する。表示用の自由記述だけに依存せず、数量を数値として保持する。

| 列 | 型 | 制約・用途 |
| --- | --- | --- |
| `id` | TEXT | UUID、主キー |
| `order_id` | TEXT | `orders.id` |
| `item_code` | TEXT | 商品識別子 |
| `item_name` | TEXT | 注文時点の表示名スナップショット |
| `quantity` | INTEGER | 1以上 |
| `note` | TEXT NULL | 任意メモ、内容は未決 |
| `created_at` | TEXT | 作成時刻 |

`order_items(order_id)` を索引化し、調理・受け渡し・管理・公開状況の明細取得で営業日全体を走査しないようにする。`order_item_options(order_item_id)`も同様に索引化する。

### 1000商品/日の確認基準

- 数量だけでなく、負荷が大きい「1000商品 = 1000明細行」の条件でも検証する。
- `EXPLAIN QUERY PLAN` で `order_items_order_id_idx` が使われることを確認する。
- 商品別集計の D1 `meta.rows_read` は、1000明細時に2100行以下を目安とする。
- 商品別集計の JSON は、1000商品種すべてが別商品という条件でも100KB未満を目安とする。
- 本番運用では Cloudflare Dashboard の D1 Metrics で Rows read / Rows written / Query response bytes を確認する。D1はデータ転送量では課金されないが、WorkerでのJSON生成量と端末通信量を抑えるため、一覧APIで不要な列を返さない方針を維持する。

## 6. `devices`

| 列 | 型 | 制約・用途 |
| --- | --- | --- |
| `id` | TEXT | サーバー側の端末ID、主キー |
| `device_key_hash` | TEXT | 24バイトのランダム端末キーをSHA-256でハッシュした値。平文キーは保存しない |
| `role` | TEXT | `RECEPTION` / `KITCHEN` / `DELIVERY` / `DISPLAY` / `ADMIN` |
| `display_name` | TEXT | 画面表示名 |
| `active` | INTEGER | 0/1 |
| `last_seen_at` | TEXT NULL | 最終接続時刻 |
| `kitchen_away` | INTEGER | 調理端末の離席状態。0/1、調理端末以外は0 |
| `kitchen_away_updated_at` | TEXT NULL | 離席状態の最終変更時刻 |
| `kitchen_heartbeat_at` | TEXT NULL | 調理画面が割り当て可能であることを最後に通知した時刻 |
| `kitchen_heartbeat_event_id` | TEXT NULL | 生存確認時に表示していた営業日ID |
| `created_at` | TEXT | 登録時刻 |

調理端末は `id` を一意に持つ。`KITCHEN-01` のような表示名と、変更されない内部IDを分離する。平文端末キーは作成・再発行時だけ管理画面に表示し、再発行すると旧キーは直ちに無効になる。離席状態はD1を正本とし、再読み込みや別画面からの管理者再待機後も維持する。

## 7. メニュー

### `menu_items`

商品本体を管理する。管理画面から作成・編集・非表示化できる。

| 列 | 型 | 制約・用途 |
| --- | --- | --- |
| `id` | TEXT | UUID、主キー |
| `name` | TEXT | 商品名 |
| `description` | TEXT NULL | 説明 |
| `sort_order` | INTEGER | 表示順 |
| `active` | INTEGER | 0/1 |
| `created_at` | TEXT | 作成時刻 |
| `updated_at` | TEXT | 更新時刻 |

### `menu_option_groups`

味付け・サイズ・トッピングなど、商品に付属する選択項目のグループを管理する。

| 列 | 型 | 制約・用途 |
| --- | --- | --- |
| `id` | TEXT | UUID、主キー |
| `menu_item_id` | TEXT | `menu_items.id` |
| `name` | TEXT | 例：味付け、サイズ |
| `selection_type` | TEXT | `SINGLE` / `MULTIPLE` |
| `required` | INTEGER | 選択必須か |
| `sort_order` | INTEGER | 表示順 |
| `active` | INTEGER | 0/1 |

### `menu_options`

サブ項目グループ内の選択肢を管理する。

| 列 | 型 | 制約・用途 |
| --- | --- | --- |
| `id` | TEXT | UUID、主キー |
| `group_id` | TEXT | `menu_option_groups.id` |
| `name` | TEXT | 例：ソース味、塩味 |
| `sort_order` | INTEGER | 表示順 |
| `active` | INTEGER | 0/1 |

注文時には商品・グループ・選択肢の名称を明細へスナップショット保存し、後からメニューを変更しても既存注文の内容を変えない。

## 8. 管理者とセッション

`app_settings.reception_menu_mode` は受付画面の表示方式を保持する。初期値は `DIRECT` とし、メニュー数が多い場合は管理画面から `CART` に切り替える。

### `admins`

| 列 | 型 | 制約・用途 |
| --- | --- | --- |
| `id` | TEXT | UUID、主キー |
| `login_name` | TEXT | 一意のログイン名 |
| `password_hash` | TEXT | パスワードハッシュ。平文不可 |
| `active` | INTEGER | 0/1 |
| `created_at` | TEXT | 作成時刻 |
| `updated_at` | TEXT | 更新時刻 |

### `admin_sessions`

| 列 | 型 | 制約・用途 |
| --- | --- | --- |
| `id` | TEXT | セッション識別子 |
| `admin_id` | TEXT | `admins.id` |
| `device_id` | TEXT NULL | 使用端末 |
| `issued_at` | TEXT | 発行時刻 |
| `last_seen_at` | TEXT | 最終確認時刻 |
| `expires_at` | TEXT | 通常の有効期限 |
| `reauth_grace_expires_at` | TEXT | 通信断復旧時の再認証猶予 |
| `revoked_at` | TEXT NULL | 明示的な失効時刻 |

再認証猶予の初期値は30分とし、管理設定で変更できるようにする。

### `admin_login_limits`

管理者ログインの総当たり防止用。Cloudflareが付与する接続元IPをSHA-256でハッシュした値、試行期間、失敗回数、一時ロック期限を保持する。IPの平文は保存しない。

| 列 | 型 | 意味 |
| --- | --- | --- |
| `client_hash` | TEXT | 接続元IPのSHA-256ハッシュ |
| `window_started_at` | INTEGER | 試行期間の開始時刻（Unixミリ秒） |
| `failure_count` | INTEGER | 期間内の失敗回数 |
| `blocked_until` | INTEGER NULL | 一時ロック期限（Unixミリ秒） |

## 9. `order_status_history`

状態変更の監査履歴を保持する。

| 列 | 型 | 制約・用途 |
| --- | --- | --- |
| `id` | TEXT | UUID、主キー |
| `order_id` | TEXT | `orders.id` |
| `from_status` | TEXT NULL | 変更前 |
| `to_status` | TEXT | 変更後 |
| `device_id` | TEXT NULL | 操作端末 |
| `operation_id` | TEXT | 操作の冪等性キー |
| `created_at` | TEXT | サーバー時刻 |
| `metadata_json` | TEXT NULL | 障害対応用の補足情報 |

管理画面で注文単位の履歴を時系列表示するため、`order_id, created_at` の複合インデックスを持つ。

## 10. 整合性ルール

- 外部キーを有効化する。
- `quantity > 0` をアプリケーションとDBの両方で検証する。
- 注文の状態変更は許可された遷移だけに限定する。
- `COMPLETED` になった注文の完了時刻は必須とする。
- `COOKING` の注文には原則として `assigned_device_id` と `cooking_started_at` を持たせる。
- 注文の更新と履歴の追加は同じD1 batchで実行し、直前の条件付き更新が1行成功した場合だけ`changes()`を条件に履歴を追加する。
- 同じ注文の同じ`operation_id`は、遷移先と操作主体が一致する場合だけ再送として扱い、異なる場合は冪等性衝突として拒否する。

## 11. キュー割り当てとD1

Queue DOが割り当て要求を1件ずつ受け付け、D1へ状態変更を書き込む。D1の検索結果だけを根拠にWorkerが後から割り当てることは禁止する。

新規注文は、同じ営業日の生存確認が有効で、稼働中・非離席・担当なしの調理端末だけを候補とする。候補間では`orders.ready_at`から求めた最終調理完了時刻が古い端末を優先し、完了実績がない端末を先にする。同時取得の直列化とこの候補選択は同じQueue DO内で行う。

障害時に「D1への更新は成功したが応答が失われた」ケースがあるため、割り当て操作には `operation_id` を付与し、再試行時に現在の割り当て結果を再取得できるようにする。

## 12. 保持・削除

初期版では自動削除を行わず、イベント終了後に管理者がエクスポート・保管方針を確認してから削除する。個人情報を扱う場合の保持期間は、運用決定後に追加する。

## 13. 未決事項

- 同じ受付番号の複数注文は許可する。注文の一意性は `orders.id` と `request_id` で管理する。
- 注文の編集を許可するか。許可する場合の履歴と調理中の扱い。
- 個人情報を注文に保持するか。
- 管理設定（セッション期間、再認証猶予など）を専用テーブルにするか。

## 14. 受付番号設定

`order_number_settings` は1行の設定テーブルとする。

- オンライン受付：`100`〜`500`、次回番号 `100`
- オフライン受付：接頭辞 `OFF-`、開始番号 `1000`
- オンライン番号の割り当てはD1の条件付き更新でサーバー側が行う。
- オフライン番号の割り当てはブラウザのIndexedDBで行い、同期時も番号を保持する。
- 設定変更は管理者だけが実行でき、既存注文の番号には影響しない。
- 営業日を開始・切替した時、または開始中の営業日名・日付を変更した時は、次回番号を設定済みの開始番号（初期値`100`）へ戻す。
# 直前操作取り消し

`undoable_operations` は操作ID、営業日、対象注文、操作者、操作種別、復元用スナップショット、10秒の期限、実行済み情報を保持する。注文状態履歴と組み合わせ、後続操作がない場合だけ逆遷移を行う。期限切れ行は監査・競合判定用に残るが、通常のポーリングでは参照しない。
