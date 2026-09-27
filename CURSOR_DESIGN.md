# カーソル設計ガイド / Cursor Design Guide

このドキュメントは，本プラットフォームで実験課題を設計する際の**カーソル可視性・平均カーソル・座標系**に関する設計指針をまとめたものです。新しい実験課題を追加するとき，あるいは既存タスクで「平均カーソルだけ動かしたい」「個別カーソルをテレポートしたい」「視覚回転を入れたい」といった要求を実現したいときに参照してください。

参考:
- 全体構造の俯瞰は [CLAUDE.md](./CLAUDE.md)
- エージェント仕様は [agent_rule.md](./agent_rule.md)
- 利用フローは [README.md](./README.md)

---

## 1. カーソルの種類

実験ステージには **4 種類のカーソル概念**が同居します。設計時はまずこれを区別してください。

| 種類 | 識別子の付き方 | 由来 | 用途 |
|---|---|---|---|
| **参加者カーソル** (participant cursor) | LiveKit identity（または Prolific PID） | 参加者のブラウザがマウス / pointer-lock 入力から生成。`cursor` topic を **30 Hz** で送信（binary 11 byte）| 各参加者の手の動きを共有する |
| **平均カーソル** (average cursor) | 計算上の単一点（`'avg'` を ID として描画）| 全参加者カーソルの算術平均をクライアントで毎フレーム計算 | 集団としての"重心"を可視化。多くの実験課題で操作対象になる |
| **グループ平均カーソル** (group average) | `'group-avg-0'`, `'group-avg-1'`, ... | 参加者をグループ分割（`computeGroups`）したとき，グループごとに平均を計算 | グループ間比較やソーシャル干渉実験 |
| **狼カーソル** (werewolf cursor) | `'werewolf-N'` | 管理者デモ用のフェイク参加者。`werewolf` topic で配信 or 管理者ローカル生成 | 参加者が少ない/いない状況でも実験を動かすデモ用 |

参加者カーソルは原則 [-4.0, 5.0] の拡張座標系で送られ（pointer-lock で stage 外に出ても追跡できる），表示は `[0, 1] × [0, 1]` のステージにマップされます。

---

## 2. 座標系

### 2-1. ステージ座標
- **論理ステージ**: `[0, 1] × [0, 1]`（正規化済み，解像度非依存）
- **物理ステージ**: CSS 上は最大 540×540 px（`stage-area` クラス）。HTML の親要素サイズに追従して `<canvas>` がリサイズされる
- **viewport**: 通常は `{ minX: 0, minY: 0, rangeX: 1, rangeY: 1 }`。`ReplayModal` は記録の bounding box にフィットさせる目的でこれをオーバーライドする
- **boundary box**: `ReplayModal` でのみ表示される `[0, 1]` の点線矩形（`drawBoundaryBox`）。実 stage との対比が見やすくなる

### 2-2. ネットワーク量子化
`cursor` topic は **11 バイトのバイナリプロトコル**:

```
[version(1)] [identity_hash(2)] [x(2)] [y(2)] [timestamp(4)]
```

座標 `(x, y)` は `[-4.0, 5.0]` の範囲を `[0, 65535]` に線形量子化（`CURSOR_RANGE_MIN/MAX`）。stage の外（pointer-lock で発生し得る）も表現できる。

復号後の座標がそのまま `cursorsRef.current` に入る → `p5StageCursors` メモが `P5Dot[]` を組み立てる → `<TaskStage>` がキャンバスに描画。

### 2-3. キープアライブと stale 排除
- 送信側: `SEND_INTERVAL_MS = 33`（≈30 Hz）+ デッドバンド `0.005`。動きがない期間も **200 ms ごとに keep-alive**
- 受信側: `STALE_CURSOR_MS = 250` で無更新カーソルを `cursorsRef` から消す（参加者が落ちたら即時消える）

---

## 3. 表示モード (`DisplayMode`)

参加者に何を見せるかは `DisplayMode` 一つで決まります。Agent は `setMode` 制御メッセージで動的に切替えます。

| Mode | 自分のカーソル | 他参加者のカーソル | 平均カーソル | 接続線 |
|---|---|---|---|---|
| `self` | 表示 | × | × | × |
| `self-with-avg` | 表示 | × | 表示 | × |
| `all-without-avg` | 表示 | 表示 | × | × |
| `all-with-avg-no-lines` | 表示 | 表示 | 表示 | × |
| `all-with-avg-lines` | 表示 | 表示 | 表示 | **表示**（各参加者→平均カーソル） |
| `avgOnly` | × | × | 表示 | × |

**Admin / ViewerMode は常に全参加者カーソルを見られる**（モードは表示判定には影響するが，admin は `isAdmin` 分岐で全カーソル可視）。

### 3-1. trial 中のデフォルト
共通フローでは試行中 `avgOnly` がデフォルト（`config.trialDisplayMode`）。これは「参加者は自分の影響を平均カーソルの動きとしてしか観察できない」という協調実験のパラダイムを担保するための既定値。**個別の試行で別モードを使いたいときは `ExecuteTrialRule.displayMode` で上書き可**。

### 3-2. 共通インストラクション中の preview
共通 11 指示の `step 10/11` は，これから始まる trial モードを参加者に**preview** させる役割を持つ。`common-flow.ts` の `describeUpcomingTaskDisplay` / `describePreTaskTransition` が `trialDisplayMode` に応じてテキスト・preview 用 display mode を生成する。

---

## 4. レンダリングパイプライン

```
┌─────────────────────────────────┐
│ 参加者ブラウザ                  │
│ pointer/joystick 入力           │
│ → sendCursor() → cursor topic   │
└──────────┬──────────────────────┘
           │ 30 Hz binary
           ▼
┌─────────────────────────────────┐
│ LiveKit Cloud SFU               │  ← 全参加者に複製配信
└──────────┬──────────────────────┘
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ Admin / Participant / Viewer ブラウザ                  │
│                                                        │
│ 1. handleDataReceived (App.tsx ~ln 4434)               │
│    └ decodeCursorPayload → upsertCursor(identity, …)   │
│      └ cursorsRef.current.set(identity, …)             │
│      └ bumpRender() ───────────────────────────────┐   │
│                                                    │   │
│ 2. cursorList = useMemo(Array.from(…), [render])   │   │
│      └ visibleCursors  = displayMode フィルタ       │   │
│      └ rawAverageCursor = 自グループ平均 (+wolves)  │   │
│      └ averageCursor   = rawAvg − avgCursorOffset  │   │
│      └ groupAverages   = グループごとの平均         │   │
│                                                    │   │
│ 3. p5StageCursors / p5StageAverages / p5StageLines │   │
│    p5StageTarget / p5StageGuide / p5StageYesNo     │   │
│    （`P5Dot[]` などの形に変換, ~ln 5058–5186)       │   │
│                                                    │   │
│ 4. <TaskStage … />                                 │   │
│    └ p5.draw 60Hz                                  │   │
│      ├ drawBaseScene (共通):                       │   │
│      │    background → boundary box → lines →      │   │
│      │    cursors → averages → Yes/No              │   │
│      └ activeSketch.drawTaskLayer (task 固有):     │   │
│           target shape / guide circle / overlay    │   │
└────────────────────────────────────────────────────────┘
```

ポイント:
- 描画は **canvas 1 枚**（DOM ステージは廃止済み）。p5.js が `60 fps` で常時 redraw
- props は `propsRef` を介して `p5.draw` から参照されるので，React 側の state を変えれば次のフレームから即反映
- ViewerMode と ReplayModal は **自前で** P5 配列を構築（cursor のソース・ラベル方針・色パレットが違うため。最後に同じ `<TaskStage>` を呼ぶ）

---

## 5. 平均カーソルの設計

### 5-1. 単一平均（デフォルト）

```
averageCursor.x = (Σ cursor.x + Σ werewolf.x) / (n_cursor + n_wolves)
averageCursor.y = (Σ cursor.y + Σ werewolf.y) / (n_cursor + n_wolves)
```

実装上は `rawAverageCursor`（参加者+狼の生の平均）と `averageCursor`（offset 補正後）の 2 段構え。**画面に出るのは `averageCursor`**，**サーバに `/agent/avg-cursor` で送るのは `rawAverageCursor`**。

参加者の場合: 自分のカーソルも平均に含める（自分のカーソルが自分の見える平均に反映される）。
Admin / Viewer の場合: 自分のカーソルは除外（admin はそもそも送らないが，`!cursor.isLocal` で安全弁）。

### 5-2. グループ平均

`computeGroups` ルールが Fisher-Yates でランダム分割し，`setGroupAssignments` を全員にブロードキャスト。

- **参加者の見方**: `groupAverages` は 1 つだけ（**自分のグループの平均**のみ計算され，それが `averageCursor` として描かれる）。「他グループの平均」は見えない。
- **Admin / Viewer の見方**: `groupAverages` に全グループの平均が入り，それぞれ `GROUP_COLORS` から色を取って同時表示

色パレット: `web/src/App.tsx` の `GROUP_COLORS` （6色: blue/green/orange/purple/cyan/pink）+ `GROUP_COLOR_FALLBACK`。`colorForGroup(gid)` ヘルパで取得。

録画には `group_assignments` (recording row), `group_count`, frame ごとの `group_averages`(JSONB) が保存されるので，replay も色分け表示できる。

### 5-3. avg-cursor offset paradigm

**問題**: reaching のような課題では「試行開始時，平均カーソルを画面下端 (0.5, 0.8) に置いて，参加者が手を上げると平均が画面上端のターゲット (0.5, 0.2) に届くようにしたい」。だが現実の平均は「参加者カーソルの算術平均」なので，参加者全員が (0.5, 0.5) からスタートしたら平均も (0.5, 0.5) になってしまう。

**解決**: **個別カーソルはいじらず，平均カーソルが乗っている座標フレームを並進シフト**する。

```
displayedAvg = rawAvg − offset
```

ここで `offset = rawAvg_at_calibration − initialPos`。試行開始の瞬間 `applyAvgCursorOffset(initialX, initialY)` を呼ぶと:
1. agent が admin から最新の `rawAvg` を取得（reaching 中は admin が 10 Hz で `/agent/avg-cursor` に POST している）
2. `offset = rawAvg − (initialX, initialY)` を計算
3. `setAvgCursorOffset` 制御メッセージで全クライアントへ broadcast
4. 各クライアントは `displayedAvg = rawAvg − offset` を描画する。試行開始の瞬間は定義により `initialPos` と一致

その後参加者が手を動かすと `rawAvg` が変化し，`displayedAvg` も同じ方向・同じ大きさで動く（1-to-1 で追従）。

**reach 判定** (`waitForAvgCursorNear`) も `displayedAvg` の座標系で行う:
```
displayedAvg = report.x - this._avgCursorOffset.x
              report.y - this._avgCursorOffset.y
dist = distance(displayedAvg, (targetX, targetY))
```

**新タスクへ適用するには**: `ExperimentTask` 上で `getInitialCursorPosition(config) → {x, y}` を実装すれば自動的にこのパスを通る。実装しなければ legacy の reset-to-(0.5, 0.5) パスを使う。

**注意**:
- このパラダイムは admin がブラウザを開いている前提（admin が `rawAvg` を 10 Hz で送らないと offset が校正できない）
- offset は試行ごとに再校正される（agent.ts の `execExecuteTrial` step 2 と step 5）。なので試行間で平均が動いていても次の試行開始時に initial 位置に戻る
- `taskMode !== 'reaching'` のときは `useEffect` 安全弁で offset を (0, 0) にリセット（座標フレームが他課題に漏れない）

### 5-4. 平均に何を含めるかの選択肢

`rawAverageCursor` の memo (`App.tsx` ~ln 2322) のロジックを変更すれば，

- 「特定参加者を除外」（例: outlier 除去）
- 「重み付き平均」
- 「中央値」

なども実装可能。ただし**サーバ側 `waitForAvgCursorNear` も同じ意味の値を比較できないと reaching が破綻する**ので，admin → agent への報告経路（`POST /agent/avg-cursor`）も合わせて変える必要がある。

### 5-5. 平均カーソルの視覚デザイン

- 単一平均: 直径 22 px (default `averageCursorSize`)，hex `#1d4ed8` (main) / `#3b82f6` (viewer)
- グループ平均: 同サイズ・`GROUP_COLORS` の色で並列描画
- **`fill` には必ず hex か RGB の文字列を使う**（HSL は整数 hue 制限あり，§9 参照）

---

## 6. 個別参加者カーソルの設計

### 6-1. 入力ソース
- **デフォルト**: マウス（ウィンドウ全体の `pointermove`）。送信は normalize 済み座標
- **virtual cursor (pointer-lock)**: 参加者がステージ中央をクリック → `requestPointerLock` → 入力は `dxNorm/dyNorm` の delta で来る → `virtualCursorPos` に加算
- **モバイル**: `MobileController` のジョイスティック（velocity-based）

### 6-2. visuomotor rotation
pointer-lock 中のみ，`handlePointerMove` の入力 delta に**回転行列**を適用:
```
[dx']   [cos θ  -sin θ] [dx]
[dy'] = [sin θ   cos θ] [dy]
```
回転角は `setCursorRotation` 制御メッセージで agent から伝達 → `cursorRotationRadRef.current` に保存。

**スコープ**:
- クライアント側で完結する（サーバには制御信号のみ）
- pointer-lock 中のみ適用（通常マウス時は不適用）
- `taskMode !== 'reaching'` で安全弁により 0 リセット

**naive participant model**: ボット (`simulate-participants.ts`) は compensation せず素直に target 方向へ歩く → 結果，rotation 中は曲線軌跡になる。これは人間の adaptation 初期動作を模した挙動で，washout 後にゼロに戻る。

### 6-3. 位置リセット / テレポート
- **`resetVirtualCursorPosition`**: 全員の virtual cursor を (0.5, 0.5) に
- **`setVirtualCursorPosition(x, y)`**: 全員の virtual cursor を (x, y) に
- 試行間で連続性を保つため，reaching では `applyAvgCursorOffset` と組み合わせて使う（[CLAUDE.md](./CLAUDE.md) の "Avg-cursor offset paradigm" 参照）

### 6-4. 個別カーソルの視覚デザイン
- 直径 18 px (default `participantCursorSize`)
- 色は **`colorFromIdentity(identity)`** が決定的に生成（hash → HSL，hue は **`Math.round` で整数化済み**）
- **Admin / Viewer はラベル付き**: `#N` (admin) or displayName (viewer)。参加者には表示しない
- RTT が分かるカーソルにはラベル末尾に `Nms` を付与，3 段階で色分け（緑/オレンジ/赤）

---

## 7. 新タスクで「カーソルの見せ方」を変える方法（how-to）

| やりたいこと | どこを変えるか |
|---|---|
| 平均カーソルの初期位置を画面下端に置きたい | `ExperimentTask.getInitialCursorPosition(config) → {x, y}` を実装。あとはフレームワークが offset paradigm を起動 |
| 個別参加者カーソルを試行開始時に特定位置に揃えたい | `ctx.setVirtualCursorPosition(x, y)` を `runTrialBody` 冒頭で呼ぶ。または `ExperimentTask.getInitialCursorPosition` の有無でフレームワークが自動でやる |
| 視覚運動回転を入れたい | `ExecuteTrialRule.cursorRotationDeg` を per-trial で指定（`generateTrialSequence` で組む）。`runTrialBody` の中で `ctx.setCursorRotation(deg)` を呼ぶことも可 |
| 試行中の display mode を「全員見える」にしたい | `ExperimentConfig.trialDisplayMode = 'all-with-avg-no-lines'` に。または `ExecuteTrialRule.displayMode` で per-trial 上書き |
| カスタムターゲット形状を描きたい | `web/src/experiments/<task-id>/sketch.ts` の `drawTaskLayer` でテキストや図形を p5 で描く。`scene.target` を読むか，sketch のクロージャに独自の state を持つ |
| ターゲットの色を試行で変えたい | `ctx.publishStaticTarget(x, y, shape, color)` の color 引数で CSS color を渡す（reaching の yellow→red 切替パターン参照） |
| グループ実験にしたい | `generateTrialSequence` で `computeGroups` ルールを試行列に差し込む（`group-circle-target-tracking/index.ts` 参照） |
| 平均カーソルから個別カーソルへの線を出したい | display mode を `'all-with-avg-lines'` にすれば自動で出る（`p5StageLines` memo が描画） |

---

## 8. データ記録（録画）との関係

`captureFrame` (App.tsx ~ln 2475) が **60 fps** で各フレームを `FrameSnapshot` として蓄積:

```
FrameSnapshot {
  frameNumber, timestamp,
  cursors: [ { identity, displayName, x, y, color, rttMs, groupId? } ],
  average:        { x, y } | null,           // ← 表示平均（offset 補正後）
  target:         { x, y, shape } | null,    // ← 表示ターゲット（reaching の色は含まれない）
  groupAverages?: { [gid]: { x, y } },       // ← group_count > 1 のときのみ
}
```

ここに**生 (raw) ではなく "表示後 (displayed)" の値が入る**ことに注意。後で解析するとき：
- 単に参加者の手の動きを見たい → `cursors[]` を集計
- 表示と offset の関係を再現したい → `recordings.group_assignments` と admin 視点の raw avg は記録されない（agent しか持っていない）。必要なら設計時に Frame に raw avg / offset の両方を残すよう拡張する

新しいタスクで recording をカスタマイズしたいときは `captureFrame` の中身を読み，必要なら追加フィールドを Supabase schema（`packages/web/supabase_schema.sql` と `supabase/init/01-schema.sql`）に `ADD COLUMN IF NOT EXISTS` で生やす。

---

## 9. 設計上の注意点 / 落とし穴

### 9-1. p5.js HSL は **整数 hue 必須**
p5.js 1.x の HSL CSS パーサーは `INTEGER = /(\d{1,3})/`，つまり 1–3 桁整数しか hue を受け付けない。`hsl(234.567, 80%, 60%)` のような小数 hue は**全パターンにマッチせず白で描かれる**。

→ CSS color string を p5.js に渡すヘルパーは **hex（`#RRGGBB`）かまたは hue を `Math.round` した HSL** にすること。`colorFromIdentity` は修正済みだが，将来追加する color ヘルパは同じ落とし穴に注意。

### 9-2. display mode による visibility は admin / participant で違う
`visibleCursors` の admin 分岐は `displayMode` を見ない（admin は常に全カーソルを見る）。一方 participant 分岐は厳密に従う。テスト時に「admin だと見えるが participant だと見えない」が出たら大抵この仕様。

### 9-3. reaching task は admin の存在に依存する
- `applyAvgCursorOffset` と `waitForAvgCursorNear` は `_avgCursorReport`（admin が POST する raw avg）が無いと機能しない
- admin タブを開かないと: offset が 0 のまま → 表示平均が start 位置に来ない → reach が起きず trial timeout で前進
- E2E テスト (`scripts/test-all-experiments.ts`) を回すときは **必ず admin ブラウザタブを開いておく**

### 9-4. 個別カーソルと平均カーソルの色の一貫性
- ライブ描画 (`p5StageCursors`) と record 内 `cursor.color` は同じ `colorFromIdentity` 経由なので一致する
- Replay 時は record 内の color を直接使う（生成しなおさない）
- 同じ identity でブラウザ越しに異なる色を出したい場合は，`colorFromIdentity` の hashing を decoupling する必要がある（現状そのユースケースはない）

### 9-5. cursor が一瞬「白」になる症状
- `colorFromIdentity` のキャッシュは無い: 毎 `upsertCursor` で再計算
- 「平均は見えるのに個別が見えない」が再発したら，**真っ先に hue が小数になっていないか確認**（§9-1 と同症状）

### 9-6. `[0, 1]` の外
- pointer-lock では cursor が stage 外に出る → x, y は負や 1 超の値になり得る
- ネットワークは `[-4, 5]` まで量子化対応
- 描画は `viewport.minX / rangeX` の sx, sy 変換で canvas 外に描かれる（自動でクリップされる）。**ターゲット判定 (`waitForAvgCursorNear`) は何の clamp もしないので注意**

### 9-7. ステージサイズに依存する閾値
- reaching の "early motion warning" 閾値は **20 px / 540 px ≈ 0.037 stage units** と stage 物理サイズに依拠
- 画面サイズが大きく違うブラウザでは閾値が相対的に変わる
- 厳密性が必要なら CSS から実 stage サイズを取って動的に正規化する（現状はやっていない）

---

## 10. テストと検証

| 目的 | 手段 |
|---|---|
| カーソルデータがちゃんと届いているか | `npx tsx scripts/debug-listener.ts` で `cursor` topic を覗く |
| 表示平均と raw 平均の差分を時系列で見る | `npx tsx scripts/debug-monitor.ts`（admin 不要） |
| admin 不在で reaching を回したい | `npx tsx scripts/debug-fake-admin.ts` で recording-status の ack + raw avg post を代行 |
| 5 タスク一括 E2E | `scripts/test-all-experiments.ts` → `scripts/validate-recordings.ts`（admin ブラウザタブ要） |
| 個別カーソルの可視性チェック | admin タブで `/?admin=<ADMIN_PASSWORD>` を開き，`displayMode = all-without-avg` などに切り替えて全 bot が見えるか確認 |
| HSL 整数 hue 退行チェック | `colorFromIdentity('sim-bot-0')` の戻り値に小数が含まれないことを単体テストで担保（未実装。将来追加候補）|

---

## 11. 関連ファイル早見表

| 概念 | ファイル / 関数 |
|---|---|
| 参加者カーソル収集 | `App.tsx → handleDataReceived` (`upsertCursor`) |
| display mode フィルタ | `App.tsx → visibleCursors` memo |
| 単一平均計算 | `App.tsx → rawAverageCursor` memo |
| 表示平均（offset 補正） | `App.tsx → averageCursor` memo |
| グループ平均計算 | `App.tsx → groupAverages` memo |
| p5 stage prop 組立 | `App.tsx → p5StageCursors / p5StageAverages / p5StageLines / p5StageTarget / p5StageGuide / p5StageYesNo` (~ln 5058–5186) |
| p5 stage 本体 | `web/src/experiments/TaskStage.tsx` |
| 共通描画 | `web/src/experiments/base-sketch.ts` + `shared/draw.ts` + `shared/yes-no.ts` |
| タスク固有描画 | `web/src/experiments/<task-id>/sketch.ts → drawTaskLayer` |
| サーバ側 avg cursor 操作 | `server/src/agent.ts → applyAvgCursorOffset / waitForAvgCursorNear / waitForAvgCursorFar` |
| 視覚回転 (server→client) | `setCursorRotation` 制御メッセージ |
| 視覚回転 (client 適用) | `App.tsx → handlePointerMove`（pointer-lock 中の delta 回転） |
| グループ計算 | `server/src/agent.ts → execComputeGroups`（Fisher-Yates） |
| 色パレット | `App.tsx → GROUP_COLORS / colorForGroup / colorFromIdentity` |
| 録画フレーム生成 | `App.tsx → captureFrame` (~ln 2475) |

---

このドキュメントは新しい設計を追加するたびに更新してください。特に **§9 落とし穴** の節は実際に踏んだ問題を追記していくと将来の人を助けます。
