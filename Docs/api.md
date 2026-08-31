# API設計（初期案）

## 1. 共通仕様

- ベースパス：`/api`
- データ形式：JSON
- 時刻：サーバー生成のISO 8601 UTC
- ID：UUIDまたはサーバー生成の不透明な文字列
- エラー形式：`{ "error": { "code": "...", "message": "...", "request_id": "..." } }`
- すべての書き込みAPIは、必要に応じて `Idempotency-Key` ヘッダーを受け付ける。
- 権限はUIではなくWorker/APIで検証する。
- 受付・調理・受け渡しの運用APIは `X-Device-ID` と `X-Device-Key` を要求する。端末キーは作成・再発行時に一度だけ平文で返し、D1にはSHA-256ハッシュだけを保存する。
- `ONLINE` の `accepted_at` は Worker の受信時刻を使用し、端末から送信された時刻は信用しない。`OFFLINE` は端末認証時に得たサーバー時刻との差を補正した受付確定時刻を使用し、7日より古い値または5分を超える未来値は Worker の受信時刻へ補正する。`created_at` はサーバーが受信・登録した時刻として分けて保存する。
- 現場端末の注文操作は成功応答に `undoOperationId` と `undoExpiresAt` を含む。元に戻せる期限はサーバー時刻で操作後10秒間とする。

### `POST /api/operations/{operation_id}/undo`

受付・調理・受け渡し端末が、自端末で行った直前の注文操作を元に戻す。本文に `eventId` と新しい `undoOperationId` を指定する。操作端末が異なる、10秒を過ぎた、または後続の状態変更がある場合は拒否する。

### `POST /api/admin/operations/{operation_id}/undo`

管理者が管理画面から行った注文取消・調理待ち戻しを元に戻す。管理者セッションが必要で、検証条件は現場端末用APIと同じ。

## 2. 端末・イベント

### `GET /api/current-business-day`

現在の営業日と利用可能な基本情報を返す。公開表示では公開可能な項目だけを返す。

旧パスの `GET /api/events/current` も互換用に残すが、端末画面はコンテンツブロッカーによる `events` パスの誤検知を避けるため、新しいパスを使用する。

### `GET /api/admin/events`

管理者向けに営業日の一覧を返す。`DRAFT`、`OPEN`、`CLOSED` を含む。

### `POST /api/admin/events`

管理画面から営業日を作成する。作成直後は `DRAFT` とする。

```json
{
  "name": "文化祭 1日目",
  "businessDate": "2026-08-20"
}
```

### `PATCH /api/admin/events/{event_id}`

営業日の名称・日付・状態を変更する。`OPEN` に変更した営業日が現在の営業日となり、他の `OPEN` 営業日は自動的に `CLOSED` になる。運用画面は `GET /api/current-business-day` から現在の営業日を自動取得するため、端末ごとの営業日ID入力を不要にする。

営業日ごとに次の発番位置を保持する。同じ営業日を`CLOSED`から再開した場合は保存位置から続け、保存位置が現在のオンライン終了番号を超えている場合だけオンライン開始番号へ戻す。営業中に終了番号へ達した場合は、従来どおり再開または設定変更まで`ONLINE_NUMBER_EXHAUSTED`とする。新しい営業日の初回開始時と、営業中の名称・日付変更時は開始番号へ戻す。

### `DELETE /api/admin/events/{event_id}`

通常の削除では、注文がなく、`OPEN` ではない営業日だけを完全に削除する。注文履歴がある営業日は保持する。

管理画面の「Danger Zone」では、テストデータ整理用に `?force=true` と `X-Danger-Confirm: DELETE-EVENT` を付けて削除できる。この操作は営業日、その営業日の全注文、注文内容、選択肢、操作履歴、キュー操作記録を完全に削除し、元に戻せない。

### 端末設定（管理画面）

端末の登録・役割設定は、管理者ログイン後に次のAPIで行う。端末IDは端末ごとに固定して登録し、運用画面を端末の役割別URLで開く。

- `GET /api/admin/devices`
- `POST /api/admin/devices`
- `PATCH /api/admin/devices/{device_id}`
- `DELETE /api/admin/devices/{device_id}`

端末作成時は `deviceKey` を一度だけ返す。既存端末は `PATCH` に `{ "rotateKey": true }` を送ると現在のキーを失効し、新しい `deviceKey` を一度だけ返す。

端末IDは英数字で始まる64文字以内の英数字・`.`・`_`・`-`に限定する。表示名は空白を除いて1〜100文字、役割は`RECEPTION`、`KITCHEN`、`DELIVERY`、`DISPLAY`、`ADMIN`のいずれかとし、作成・更新の両方でAPI側が検証する。`active`と`rotateKey`は真偽値以外を受け付けない。同じ物理端末でも、役割ごとに別ウィンドウを開き、それぞれ対応する端末ID・キーで認証できる。認証情報はウィンドウ単位で保持し、別ウィンドウへ共有しない。

### `GET /api/device/session`

端末ヘッダーを検証し、認証済み端末のID、表示名、役割に加え、サーバー時刻の `authenticatedAt`、設定済みの `reauthGraceMinutes`、`reauthGraceExpiresAt` を返す。受付画面はこの期限内だけオフライン受付を許可する。無効なキーは `401`、要求された運用APIと役割が一致しない場合は `403` とする。

### `POST /api/auth/login`

管理者端末で作成したログイン名とパスワードでログインする。ログイン名は前後の空白を除いた3〜64文字、パスワードは12〜256文字に制限し、JSONの型もWorker入口で検証してからハッシュ処理へ渡す。パスワードはサーバー側でハッシュ照合し、成功時にセッションを発行する。同じ接続元から10分間に5回失敗すると15分間ロックし、`429 RATE_LIMITED` と `Retry-After` を返す。接続元IPはハッシュ化して保持し、平文では保存しない。

```json
{
  "loginName": "admin",
  "password": "..."
}
```

初回起動時に管理者が未作成の場合は、ログイン画面からセットアップ画面へ遷移し、最初の管理者アカウントを作成する。セットアップには32文字以上のWorker Secret `ADMIN_SETUP_TOKEN` と一致するトークンを必須とし、公開直後の第三者による管理者先取りを防ぐ。通常の運用開始後は、管理者が存在するためセットアップAPIは `409` を返す。

### `GET /api/auth/setup-status`

管理者が未作成かつ有効な`ADMIN_SETUP_TOKEN`が設定されている場合だけ`{ "available": true }`を返す。管理画面はこの結果が`true`のときだけ初回管理者作成ボタンを表示する。応答はキャッシュしない。

### `POST /api/auth/logout`

現在のセッションをサーバー側で明示的に失効させる。ログアウト後は同じBearerトークンを再利用できない。

### `POST /api/auth/recover`

ログイン情報を忘れた場合の強制復旧用。Cloudflare Worker Secret `ADMIN_RECOVERY_TOKEN`（32文字以上）と、新しいログイン名・パスワードを送る。登録済みの有効な管理者が1人だけの場合に限り、そのログイン情報を更新して全管理者セッションを失効させる。注文、営業日、メニュー、端末、設定などの業務データは変更しない。複数の有効な管理者がいる場合は、安全のため自動復旧しない。

### `GET /api/admin/settings/session`

通常のセッション有効期間と、通信断復旧時の再認証猶予を取得する。再認証猶予の初期値は30分とする。

### `PATCH /api/admin/settings/session`

通常のセッション有効期間と再認証猶予を変更する。

```json
{
  "sessionDurationMinutes": 480,
  "reauthGraceMinutes": 30
}
```

## 3. 受付API

### `POST /api/orders`

受付端末のみが実行できる。

```json
{
  "mode": "ONLINE",
  "items": [
    { "item_code": "yakisoba", "item_name": "焼きそば", "quantity": 2 },
    { "item_code": "takoyaki", "item_name": "たこ焼き", "quantity": 1 }
  ],
  "request_id": "client-generated-idempotency-key"
}
```

`ONLINE` の場合、受付番号はサーバーが設定された範囲から発行する。初期値は `100`〜`500` で、上限到達後は管理者が設定を変更するまで受付を拒否する。通信断からの再送など、すでに端末側で番号を発行した注文は `mode: "OFFLINE"` とし、`ticket_number` を保持したまま登録する。オフライン番号は管理設定の接頭辞と開始番号に一致する形式だけを受け付ける。

処理内容：入力検証、冪等再送の確認、イベント確認、メニュー正本との照合、注文作成、`WAITING` 設定、監査履歴追加、Queue DOへの通知。同じ `eventId` と `requestId` の再送は、同時に到着した場合も既存注文を返し、新しい受付番号を消費しない。オンライン番号の確定と注文挿入はD1の同一トランザクションで行う。商品名はクライアント値を信用せず、`itemCode` に対応するメニュー名を保存する。オンライン注文では無効化済みの商品・選択肢を拒否し、オフライン中に受け付け済みの注文は既存メニューとの一致を確認したうえで無効化後も同期できる。

### `GET /api/orders/{order_id}`

権限に応じて注文詳細を返す。公開表示用途ではこのAPIを直接公開せず、表示用APIを利用する。

## 4. 調理キューAPI

### `POST /api/kitchen/next`

調理端末が次の注文を取得する。実処理は営業日のQueue DOへ転送する。

```json
{
  "eventId": "...",
  "deviceId": "KITCHEN-01",
  "operationId": "client-generated-idempotency-key"
}
```

レスポンス例：

```json
{
  "assignment": {
    "id": "...",
    "ticket_number": "0123",
    "status": "COOKING",
    "assigned_device_id": "KITCHEN-01",
    "items": [
      {
        "item_name": "焼きそば",
        "quantity": 1,
        "options": [{ "group_name": "味付け", "option_name": "ソース" }]
      }
    ]
  },
  "resumed": true,
  "waitingCount": 3
}
```

同じ端末に`COOKING`の注文がすでに割り当てられている場合は、その注文を`resumed: true`で返す。`waitingCount`には、現在の割り当てとは別に残っている`WAITING`注文数を返す。割り当て済み注文も待機注文もない場合は`assignment: null`と`waitingCount: 0`を返す。

クライアントが現在表示中の注文IDを`knownOrderId`で送信し、その注文が引き続き担当中の場合は、`assignmentUnchanged: true`と`assignmentId`を返して商品明細の再取得を省略する。

離席中の端末には新しい注文を割り当てない。ただし「この注文の完了後に離席」を選んだ端末が`COOKING`注文を保持している場合は、再読み込み後もその注文を復元する。

新規割り当ての候補は、同じ営業日を直近15秒以内に確認している、稼働中・非離席・担当注文なしの調理端末に限定する。その中で当該営業日の最終調理完了時刻が最も古い端末を優先し、完了実績がない端末は完了実績がある端末より先に選ぶ。要求元が今回の候補でない場合は`assignment: null`、`deferred: true`を返し、端末の定期確認またはリアルタイム通知で再試行する。

### `GET /api/kitchen/state`

調理端末の離席状態、現在の担当注文、待機注文数を割り当てなしで取得する。`KITCHEN`端末認証と、要求端末IDの一致を必須とする。

### `POST /api/kitchen/presence`

調理端末の稼働・離席状態を変更する。担当注文が調理開始前の場合は`mode: "REQUEUE_UNSTARTED"`と`confirmedUnstarted: true`を要求し、注文を`WAITING`へ戻してから離席する。調理開始済みの場合は`mode: "FINISH_CURRENT"`で担当を維持したまま離席予定とし、完了後に新しい注文を割り当てない。離席解除後は通常の割り当てを再開する。

### `POST /api/orders/{order_id}/ready`

割り当てられた調理端末のみが実行できる。注文が `COOKING` であること、`assigned_device_id` が一致すること、操作IDが未処理であることを確認して `READY` に変更する。状態更新に成功した時だけ同じD1 batch内で監査履歴を追加する。同じ端末・遷移・操作IDの再送だけを成功済みとして返し、別遷移や別端末による操作IDの衝突は`409 IDEMPOTENCY_CONFLICT`とする。

## 5. 受け渡しAPI

### `GET /api/delivery/ready`

`READY` の注文を受け渡し画面向けに返す。チケット番号に加え、商品名、数量、味付けなどの選択肢、備考を `items` に含める。並び順は `ready_at ASC, id ASC` とする。

### `POST /api/delivery/orders/{order_id}/rework`

受け渡し端末が、受け渡し前に再調理が必要と判断した `READY` 注文を、直前の担当調理端末へ `COOKING` として戻す。前担当端末が別の `COOKING` 注文を保持している場合は、その注文を先に `WAITING` へ戻して割り当てを解除する。対象注文の `ready_at` はクリアし、両方の状態遷移を監査履歴へ保存する。営業日単位のQueue DO内で割り当て・完了・取消と直列化し、`operationId`による冪等再送に対応する。

### `POST /api/orders/{order_id}/complete`

受け渡し端末のみが実行できる。注文が `READY` であることを確認して `COMPLETED` に変更し、`completed_at` を記録する。調理完了と同じく、更新と監査履歴をD1 batch内で連動させ、操作IDの再送と衝突を区別する。

## 6. 表示・お客様照会API

### `GET /api/display/cooking`

`COOKING` のチケット番号など、公開を許可した情報だけを返す。

### `GET /api/display/ready`

`READY` のチケット番号など、公開を許可した情報だけを返す。

表示一覧APIは読み取り専用で、`DISPLAY`端末認証を必須とする。

### `GET /api/public/order-status?ticketNumber={ticket_number}`

認証不要のお客様向け照会API。現在`OPEN`の営業日だけを対象に、受付番号、状態、調理待ち中に前にある注文数と商品点数を返す。注文ID、商品名、選択肢、備考、担当端末などは返さず、`Cache-Control: no-store`を付ける。

公開画面の保険ポーリングは30秒間隔とし、非表示タブでは停止する。`READY`、`COMPLETED`、`CANCELLED`到達後は自動更新を終了し、手動更新だけを残す。

### `GET /api/reception-settings`

受付画面の表示方式を返す。`DIRECT` は商品ボタンを常時表示し、`CART` は「商品を追加」から商品を選ぶ方式とする。どちらも商品選択後はポップアップでサブ項目ごとの個数を指定する。

### `GET /api/reception/product-summary`

受付端末認証を要求し、現在`OPEN`の営業日の商品別注文数を返す。`eventId`を省略した場合は現在の営業日を対象とし、終了済み営業日を指定した場合は`409 EVENT_NOT_OPEN`とする。味付け・追加項目・備考は集計軸に含めず、商品コードと注文時の商品名でまとめる。`quantity`と`order_count`は取消済み注文を除き、注文数量が0の商品は返さない。応答は`Cache-Control: no-store`とする。

## 7. 管理API

### `GET /api/admin/menu`

管理者向けに、商品・サブ項目グループ・選択肢を階層化して返す。

### `POST /api/admin/menu/items`

商品を作成する。

### `PATCH /api/admin/menu/items/{item_id}`

商品名、説明、表示順、公開状態を変更する。既存注文のスナップショットは変更しない。

`sortOrder` を変更してメニューの表示順を更新する。管理画面では上下ボタンから更新する。

受付画面は`selectionType: "SINGLE"`をラジオボタン、`selectionType: "MULTIPLE"`をチェックボックスとして表示し、`required: true`のグループを未選択のまま注文へ追加できないようにする。複数グループの選択結果は1つの商品明細へまとめ、その構成に対して数量を指定する。Workerも同じ制約を検証し、UIを迂回した不正な組み合わせを拒否する。

### `DELETE /api/admin/menu/items/{item_id}`

商品を論理削除し、受付画面から非表示にする。既存注文の明細は保持する。

### `POST /api/admin/menu/items/{item_id}/option-groups`

味付け・サイズ・トッピングなどのサブ項目グループを作成する。

### `PATCH /api/admin/menu/option-groups/{group_id}`

サブ項目グループの表示順、名称、選択方式、有効状態を変更する。

### `POST /api/admin/menu/option-groups/{group_id}/options`

サブ項目グループに選択肢を追加する。

### `PATCH /api/admin/menu/option-groups/{group_id}/options/{option_id}`

選択肢の表示順、名称、有効状態を変更する。管理画面では上下ボタンから表示順を更新する。

### `DELETE /api/admin/menu/option-groups/{group_id}`

味付け・サブ項目グループを論理削除し、配下の選択肢も受付画面から非表示にする。

### `DELETE /api/admin/menu/option-groups/{group_id}/options/{option_id}`

味付け・サブ項目の選択肢を論理削除する。既存注文のスナップショットは変更しない。

### `GET /api/admin/order-number-settings`

オンライン受付番号の開始番号・終了番号・次回番号と、オフライン受付番号の接頭辞・開始番号・次回番号を返す。

### `PATCH /api/admin/order-number-settings`

受付番号設定を変更する。初期値は次のとおり。

```json
{
  "onlineStartNumber": 100,
  "onlineEndNumber": 500,
  "offlinePrefix": "OFF-",
  "offlineStartNumber": 1000
}
```

オンライン番号はサーバー側で連番発行し、オフライン番号はブラウザのIndexedDBで接頭辞と連番を組み合わせて発行する。設定変更後も、すでに受付済みの注文番号は変更しない。

### `GET /api/admin/settings/session`

通常の管理者セッション期間と、通信断復旧時の再認証猶予を返す。

### `PATCH /api/admin/settings/session`

セッション期間と再認証猶予を管理画面から変更する。初期値はそれぞれ480分、30分。

### `GET/PATCH /api/admin/settings/reception`

受付画面の表示方式を管理する。`mode` は `DIRECT` または `CART`。

```json
{ "mode": "CART" }
```

### `GET /api/admin/devices`

登録済み端末と役割を返す。

### `POST /api/admin/devices`

端末ID、表示名、役割を登録する。役割は `RECEPTION`、`KITCHEN`、`DELIVERY`、`DISPLAY`、`ADMIN`。

### `PATCH /api/admin/devices/{device_id}`

端末の表示名、役割、有効状態を変更する。

### `DELETE /api/admin/devices/{device_id}`

調理中の注文が割り当てられていない端末を削除する。過去の注文・監査履歴の担当端末IDは文字列として保存済みのため維持される。

### `GET /api/admin/menu`

商品、サブ項目グループ、選択肢を階層化して返す。

### `POST /api/admin/menu/items`

商品を作成する。商品名、説明、表示順、公開状態を設定する。

### `PATCH /api/admin/menu/items/{item_id}`

商品を編集・非表示化する。過去の注文スナップショットは変更しない。

### `POST /api/admin/menu/items/{item_id}/option-groups`

味付け・サイズ・トッピングなどのサブ項目グループを作成する。

### `POST /api/admin/menu/option-groups/{group_id}/options`

サブ項目グループの選択肢を作成する。

### `GET /api/admin/orders`

ステータス、チケット番号、商品明細、受付・調理開始・調理完了・提供完了の各日時、担当調理端末を含む一覧を返す。

### `GET /api/admin/orders/{order_id}/history`

管理権限を要求し、対象注文の現在状態と、受付から現在までの状態遷移を時刻順で返す。各履歴には変更前後の状態、操作端末または管理者ID、操作ID、サーバー時刻、取消理由などの監査メタデータを含む。応答はキャッシュしない。

### `POST /api/admin/orders/{order_id}/requeue`

管理者が、故障・離脱した調理端末に割り当てられた `COOKING` 注文を `WAITING` に戻す。`assigned_device_id` と `cooking_started_at` をクリアし、状態履歴へ管理者による手動復旧として記録する。状態更新に成功した時だけ同じD1 batch内で履歴を追加し、調理端末の完了操作と競合した場合は片方だけを成功させる。同じ管理者・遷移・操作IDの再送だけを成功済みとして返す。自動タイムアウトでは実行せず、管理画面の確認操作からのみ行う。

### `POST /api/admin/orders/{order_id}/cancel`

管理者が `WAITING`、`READY`、`COMPLETED` の注文を `CANCELLED` にする。本文には再送を安全にする `operationId` と、1〜200文字の `reason` を必須とする。`COOKING` の強制取消は管理者だけが実行でき、通常項目に加えて `forceCooking: true` と対象の受付番号に一致する `confirmedTicketNumber` を要求する。画面では理由入力と受付番号再入力の二段階確認を行う。取消理由と管理者IDを状態履歴へ保存し、営業日のQueue DO内で次注文の割り当て・完了・差し戻しと直列化する。同じ操作IDの再送は同じ取消結果を返す。

### `GET /api/reception/orders/lookup`

受付端末権限を要求し、現在の営業日IDと受付番号を指定して注文詳細を返す。受付番号、現在状態、商品、数量、選択肢を確認してから取消操作へ進むために使用する。

### `POST /api/reception/orders/{order_id}/cancel`

受付端末が注文詳細を確認した後、`WAITING`、`READY`、`COMPLETED` の注文を取り消す。管理者取消と同じく`operationId`と取消理由を必須とし、受付端末IDを監査履歴へ保存する。`COOKING`は管理者が調理待ちへ戻すまで取り消せない。

### `GET /api/admin/summary`

`includeProducts=false` を指定した場合は、ステータス別件数と合計件数だけを返し、商品別集計を実行しない。注文数が変化しないステータス更新時のリアルタイム再取得に使用する。

`WAITING`、`COOKING`、`READY`、`COMPLETED` 等の注文件数に加え、取消済み注文を除いた注文商品の数量合計を `itemTotal` として返す。`productCounts`には商品別の注文件数・注文数量・取消数量・総数量を返す。味付けなどのオプションは商品別集計に影響しない。

### `GET /api/admin/export.csv`

管理権限を要求し、ExcelやGoogleスプレッドシートで開けるCSVを返す。`items` 列には商品名、選択肢、備考、数量をまとめる。UTF-8 BOM付きUTF-8、CRLF改行で返す。

### `GET /api/admin/product-summary.csv`

管理権限を要求し、商品別集計を1商品1行で返す。列は`item_code`、`item_name`、`order_count`、`quantity`、`cancelled_quantity`、`total_quantity`。味付け・追加項目・備考は列や集計軸に含めない。UTF-8 BOM付きUTF-8、CRLF改行で返す。

## 8. WebSocket

### `GET /api/realtime`

`Upgrade: websocket` を要求する。Workerは営業日が存在して`OPEN`であることを検証してから、その営業日のQueue DOへ接続を転送する。未知の営業日は`404`、終了済み・準備中の営業日は`409`で拒否し、任意のIDからDurable Objectが参照されることを防ぐ。

初期版の通知ペイロードはイベント種別・営業日ID・内部注文IDだけで、商品内容やチケット番号を含めない。公開表示も同じ通知を再読込のきっかけとして使うためWebSocket接続自体は公開し、実データの取得・更新APIで端末権限を検証する。

イベント例：

```json
{
  "type": "order.updated",
  "event_id": "...",
  "order_id": "...",
  "status": "READY",
  "version": 12
}
```

通知は状態変化の合図であり、クライアントは受信後にAPIから必要な現在状態を再取得する。接続復旧時にも同じ再取得を行う。

通知イベントは営業日単位で配信する。

- `order.created`
- `order.cooking`
- `order.ready`
- `order.completed`
- `order.requeued`
- `order.cancelled`

WebSocketが切断された場合は再接続し、既存の一覧APIで現在状態を再取得する。ポーリングは接続障害時の保険として残す。

定義されていない`/api/*`はSPAへフォールバックせず、`API_NOT_FOUND`のJSONを`404`かつ`Cache-Control: no-store`で返す。

## 9. HTTPステータスとエラーコード

| HTTP | 用途 | 例 |
| --- | --- | --- |
| `400` | 入力不正 | `INVALID_REQUEST` |
| `401` | 未認証 | `UNAUTHENTICATED` |
| `401` | 端末未認証・キー不正 | `DEVICE_AUTH_REQUIRED` / `INVALID_DEVICE_CREDENTIALS` |
| `403` | 端末役割不一致 | `DEVICE_ROLE_FORBIDDEN` / `DEVICE_MISMATCH` |
| `403` | 役割不足 | `FORBIDDEN_ROLE` |
| `404` | 対象・API・営業日なし | `ORDER_NOT_FOUND`, `API_NOT_FOUND`, `EVENT_NOT_FOUND` |
| `409` | 状態競合・冪等性不一致・営業日未公開 | `INVALID_STATE_TRANSITION`, `IDEMPOTENCY_CONFLICT`, `EVENT_NOT_OPEN` |
| `429` | 過剰要求 | `RATE_LIMITED` |
| `500` | サーバー内部エラー | `INTERNAL_ERROR` |

## 10. 未決事項

- 初回セットアップ完了を示す設定値の保存場所。
- `event_id` をURL・セッション・リクエストのどこで指定するか。
- APIのバージョン表記を `/api/v1` にするか。
- 注文内容を確定後に編集できるようにするか。
- WebSocketの購読対象を役割ごとに固定するか、サーバー側で自動決定するか。
