# 本番デプロイガイド

このドキュメントは、LiveKit Cursor Mesh を本番環境にデプロイ・更新する際の手順をまとめたものです。本番環境は **Render.com**（サーバー + Web 配信）と **Supabase Cloud**（録画 DB）の 2 つのサービスで構成されています。

---

## TL;DR — このアップデートで必要な作業

**グループ実験機能（`group-circle-target-tracking` タスク）追加に伴い、Supabase Cloud で DB スキーマ移行が必要です。Render 側は環境変数の変更不要、コードは git push で自動デプロイされます。**

順序が重要です：

1. **Supabase Cloud で先に SQL を実行**（[手順](#1-supabase-cloud--スキーマ移行)）
2. **その後 Render にコードを push してデプロイ**

逆順だと新コードが「存在しない列」へ INSERT を試みて録画機能が壊れます。

---

## 目次

1. [このアップデートで変更が必要なもの](#このアップデートで変更が必要なもの)
2. [Supabase Cloud — スキーマ移行](#1-supabase-cloud--スキーマ移行)
3. [Render.com — コードデプロイ](#2-rendercom--コードデプロイ)
4. [動作確認（スモークテスト）](#3-動作確認スモークテスト)
5. [後方互換性メモ](#後方互換性メモ)
6. [ロールバック手順](#ロールバック手順)
7. [環境変数リファレンス](#環境変数リファレンス)
8. [初回デプロイ手順（参考）](#初回デプロイ手順参考)
9. [トラブルシューティング](#トラブルシューティング)

---

## このアップデートで変更が必要なもの

| 対象 | 変更内容 | 必須/任意 |
|------|---------|-----------|
| **Supabase Cloud DB スキーマ** | `recordings` に 2 列、`frames` に 1 列追加 | **必須** |
| **Render.com 環境変数** | 変更なし | — |
| **Render.com コード** | 自動デプロイ（main ブランチを更新するだけ） | **必須** |
| **LiveKit Cloud** | 変更なし | — |
| **既存録画データ** | 変更不要（デフォルト値で埋まる） | — |

### 何が新しくなったか

- 新タスクタイプ `group-circle-target-tracking` を追加（参加者を 2 グループに分けて 5 試行 × 3 フェーズの実験）
- 録画スキーマに **3 列追加**: `recordings.group_assignments`, `recordings.group_count`, `frames.group_averages`
- 既存タスク（circle-target-tracking, guide-tracking, non-guide-tracking）は変更なし
- 環境変数・API・LiveKit 設定は変更なし

---

## 1. Supabase Cloud — スキーマ移行

### 手順

1. https://supabase.com/dashboard にログイン → 該当プロジェクトを開く
2. 左サイドバー **「SQL Editor」** → **"New query"** ボタン
3. 下記 SQL をコピー & ペースト → **"Run"** ボタンで実行

```sql
-- グループ実験機能のための列追加（2026-05 アップデート）
-- IF NOT EXISTS により再実行しても安全（idempotent）

ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS group_assignments JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS group_count INTEGER NOT NULL DEFAULT 1;

ALTER TABLE frames
  ADD COLUMN IF NOT EXISTS group_averages JSONB NOT NULL DEFAULT '{}'::jsonb;
```

成功すると "Success. No rows returned" と表示されます。

### 確認

同じ SQL Editor で次を実行し、3 行返ってくれば OK：

```sql
SELECT table_name, column_name, data_type, column_default
FROM information_schema.columns
WHERE column_name LIKE 'group%'
  AND table_name IN ('recordings', 'frames')
ORDER BY table_name, column_name;
```

期待される結果：

| table_name | column_name | data_type | column_default |
|-----------|-------------|-----------|---------------|
| frames | group_averages | jsonb | `'{}'::jsonb` |
| recordings | group_assignments | jsonb | `'{}'::jsonb` |
| recordings | group_count | integer | `1` |

### スキーマキャッシュについて

**ローカル開発**では PostgREST がスキーマをキャッシュするため `NOTIFY pgrst, 'reload schema';` または `docker restart` が必要です。**Supabase Cloud では自動的に再読み込みされる**ので追加作業は不要です。

### RLS ポリシー

新列は既存の `FOR INSERT/SELECT/UPDATE` ポリシーが自動的に適用されます（PostgreSQL の RLS は列単位ではなく行単位）。**追加のポリシー設定は不要**です。

### 既存録画データへの影響

既に保存されている録画データは：
- `group_assignments` → `{}`（空オブジェクト）
- `group_count` → `1`（グループなし）
- `group_averages` → `{}`（空オブジェクト）

がデフォルトで埋まります。**既存録画は問題なくリプレイ・ダウンロード可能**です（コードは `groupCount > 1` のときのみグループ用のレンダリングをするため）。

---

## 2. Render.com — コードデプロイ

### 自動デプロイ（推奨）

Render は `render.yaml` で blueprint デプロイされており、`main` ブランチへの push で自動的に再ビルドされます。

```bash
# ローカルでテスト・型チェックを通したうえで
git checkout main
git merge <feature-branch>
git push origin main
```

Render ダッシュボードの "Deploys" タブでビルド進行状況を確認できます。ビルドコマンド（`render.yaml` 参照）：

```bash
npm ci
npm run build --workspace=@cursor/web
npm run build --workspace=@cursor/server
```

起動コマンド：

```bash
node packages/server/dist/index.js
```

### 手動デプロイ

ダッシュボードの "Manual Deploy" → "Deploy latest commit" から強制再ビルド可能。

### ビルド時間の目安

Render Free プランで初回〜2 分程度。途中で失敗する場合は "Logs" タブを確認してください。

### 環境変数の確認

このアップデートでは**新しい環境変数は不要**です。既存の以下が設定済みであれば動作します：

- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `LIVEKIT_WS_URL`
- `ADMIN_PASSWORD`
- `TOKEN_TTL_SECONDS`（任意）

**Web 側（VITE_*）は build 時に Render の環境変数を参照する必要があります**。`VITE_SUPABASE_URL` と `VITE_SUPABASE_ANON_KEY` が設定されていることを確認してください（後述の[環境変数リファレンス](#環境変数リファレンス)参照）。

---

## 3. 動作確認（スモークテスト）

デプロイ後に最低限確認すべき項目：

### 既存機能の回帰チェック

1. 公開 URL（例: `https://cursor-app-qfy5.onrender.com/`）が表示されること
2. 同意画面が出ること
3. `?admin=<pass>` で Admin として接続できること
4. 既存録画を Database Admin から再生できること（壊れていないこと）

### 新機能の確認

1. `?admin=agent` で Agent Admin にアクセス
2. Task Type の選択肢に **"Group Circle Target Tracking"** が出ること
3. 設定例: trialCount=2, trialDurationSeconds=10, minParticipants=2, waitTimeMinutes=1（短時間テスト用）
4. 別ブラウザ 2 つで参加者として接続
5. Save Config → Start Agent
6. **コンソールログ**で `[Agent] computeGroups: 2 participants → 2 groups (sizes: 1, 1)` が出ること
7. トライアル中に Admin タブで **2 つの平均カーソル**（青と緑）が表示されること
8. 録画完了後、Database Admin の Replay でグループ別軌跡が再現されること

### Supabase 側の確認

```sql
-- 最新の録画を見て group_count と group_assignments が記録されているか
SELECT id, experiment_name, trial_number, group_count, group_assignments
FROM recordings
ORDER BY created_at DESC
LIMIT 5;

-- 最新の frame で group_averages が入っているか
SELECT frame_number, group_averages
FROM frames
WHERE recording_id = (SELECT id FROM recordings ORDER BY created_at DESC LIMIT 1)
LIMIT 3;
```

---

## 後方互換性メモ

| 状況 | 動作 |
|------|------|
| 旧クライアント（キャッシュ済み JS）→ 新サーバー | OK。`setGroupAssignments` メッセージは未知の type として無視される。グループ実験は実施できないが、既存タスクは正常動作 |
| 新クライアント → 旧サーバー（理論上） | このリポジトリでは server と web を同一 Render サービスでデプロイしているため発生しない |
| 旧録画（group 列なし） → 新コード | OK。デフォルト値で埋まる。Replay は `groupCount === 1` ブランチを通り従来通り表示 |
| 新録画 → 旧 Replay コード（理論上） | 発生しない（同時デプロイのため）。万が一の場合、`groupAverages` 列は無視され単一 avg のみ表示される |

ユーザーには **ハードリロード（Cmd+Shift+R）を促す**ことで、キャッシュ済み旧 JS を確実に更新できます。

---

## ロールバック手順

何か問題が起きた場合の戻し方：

### コードのロールバック

Render ダッシュボード → 該当サービス → "Deploys" → 前のデプロイの "Rollback" ボタンをクリック。または：

```bash
git revert <commit-hash>
git push origin main
```

### スキーマのロールバック（通常は不要）

新列は既存ポリシーに干渉せず、`DEFAULT` 値があるため**ロールバックの必要はほぼありません**。万が一削除する場合：

```sql
-- ⚠️ 注意: 既存のグループ実験録画データが失われます
ALTER TABLE recordings DROP COLUMN IF EXISTS group_assignments;
ALTER TABLE recordings DROP COLUMN IF EXISTS group_count;
ALTER TABLE frames DROP COLUMN IF EXISTS group_averages;
```

新コードを残したままこれを実行すると INSERT エラーになるので、**コードを先にロールバック**してください。

---

## 環境変数リファレンス

### Render.com（サーバー側）

`render.yaml` で `sync: false` 指定の変数は Render ダッシュボードで実値を設定する必要があります。

| 変数 | 必須 | 説明 | 例 |
|------|------|------|-----|
| `LIVEKIT_API_KEY` | ✅ | LiveKit Cloud の API Key | `APIxxxxxxxxxx` |
| `LIVEKIT_API_SECRET` | ✅ | LiveKit Cloud の API Secret | `secretxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `LIVEKIT_WS_URL` | ✅ | LiveKit Cloud の WebSocket URL | `wss://your-project.livekit.cloud` |
| `ADMIN_PASSWORD` | ✅ | 管理者パスワード（**必ず変更**） | `<strong-password>` |
| `TOKEN_TTL_SECONDS` | ⛔ | トークン有効期限（秒） | `600`（デフォルト） |
| `NODE_VERSION` | ⛔ | Node バージョン | `20`（render.yaml で指定済み） |
| `PORT` | ⛔ | ポート番号 | Render が自動割当 |

### Render.com（Web ビルド時）

ビルド時に `VITE_*` プレフィックス変数が JS にバンドルされます。以下を Render ダッシュボードでサービスに設定してください：

| 変数 | 必須 | 説明 |
|------|------|------|
| `VITE_SUPABASE_URL` | ✅ | Supabase Cloud のプロジェクト URL（例: `https://xxxxx.supabase.co`） |
| `VITE_SUPABASE_ANON_KEY` | ✅ | Supabase Cloud の anon public key（Settings → API） |
| `VITE_COMPLETION_URL` | ⛔ | Prolific 完了 URL（任意。コード内のデフォルトを上書き） |
| `VITE_TOKEN_SERVER` | ⛔ | トークンサーバー URL。本番では同一オリジン配信のため未設定でOK |

> **重要**: `VITE_*` 変数を変更したら **再ビルドが必要**です（manual deploy）。Render ダッシュボードの "Environment" タブで変更後に "Save, rebuild, and deploy" を選択してください。

### Supabase Cloud

| 設定 | 取得方法 |
|------|---------|
| Project URL | Settings → API → Project URL |
| anon public key | Settings → API → anon public key |
| service_role key | Settings → API（**フロントには絶対に置かない**） |

---

## 初回デプロイ手順（参考）

ゼロから本番環境を構築する場合の流れ：

### 1. LiveKit Cloud プロジェクト作成

1. https://cloud.livekit.io/ でプロジェクト作成
2. Settings → Keys から API Key / Secret / WebSocket URL を取得
3. クォータ確認（100 人ルームを想定する場合は要確認）

### 2. Supabase Cloud プロジェクト作成

1. https://supabase.com/dashboard で New Project
2. SQL Editor を開く
3. `packages/web/supabase_schema.sql` の内容を全てコピーして実行
   - これでテーブル + インデックス + RLS ポリシー + group 列がすべて作成されます
4. Settings → API から URL と anon key を取得

### 3. Render.com でデプロイ

1. リポジトリを GitHub に push
2. Render ダッシュボード → New → Blueprint → リポジトリを選択
3. `render.yaml` が自動検出され `cursor-app` サービスが作成される
4. "Environment" タブで以下を設定（[環境変数リファレンス](#環境変数リファレンス)参照）：
   - `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_WS_URL`
   - `ADMIN_PASSWORD`
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
5. "Save, rebuild, and deploy"

### 4. 動作確認

公開 URL にアクセスして同意画面が出れば OK。録画機能のテストは `?admin=database` から実施。

---

## トラブルシューティング

### 録画 INSERT が "PGRST204 column does not exist" で失敗

**原因**: Supabase Cloud のスキーマ移行を忘れている、またはコードを先にデプロイしてしまった。

**対処**: [Step 1 のスキーマ移行](#1-supabase-cloud--スキーマ移行)を実行。Cloud は自動でキャッシュ更新されるので、SQL 実行直後から正常動作するはずです。

### Render のビルドが "Cannot find module" で失敗

**原因**: workspace 依存の解決順序、または `npm ci` キャッシュ。

**対処**: Render ダッシュボードの "Manual Deploy" → "Clear build cache & deploy"。それでもダメなら "Logs" を確認。

### グループ実験を Start しても全員が同じ平均カーソルを見る

**原因**: ユーザーのブラウザが**古い JS をキャッシュしている**ため `setGroupAssignments` メッセージが処理されない。

**対処**:
1. ブラウザに**ハードリロード**（Cmd+Shift+R / Ctrl+Shift+R）を案内
2. それでもダメな場合は、Render ダッシュボードでビルドが成功したか確認
3. Network タブで `/assets/index-*.js` のハッシュが新しくなっているか確認

### Render Free プランでスリープ後の起動が遅い

**仕様**: Free プランは 15 分非アクセスでスリープ → 次回アクセス時に 30 秒〜1 分の cold start。

**対処**:
- 実験開始 5 分前に Admin URL にアクセスしてウォームアップ
- 商用利用なら Starter プラン以上にアップグレード
- エージェントは Render プロセス内で動作するため、スリープ中は実行も停止します（再起動でリセット）

### LiveKit に接続できない（401/403）

**原因**: Render の環境変数 `LIVEKIT_*` が間違っている、またはトークン TTL 切れ。

**対処**:
1. Render ダッシュボード → Environment で `LIVEKIT_API_KEY` の値を再確認（コピペ時の前後空白に注意）
2. `LIVEKIT_WS_URL` が `wss://...livekit.cloud` 形式か
3. ブラウザコンソールで `/token` レスポンスの中身を確認

### Admin タブを開かないと録画できない

**仕様**: 録画は Admin クライアントの JavaScript が実行します（サーバーは録画していません）。エージェント実行中は **メイン Admin タブ（`?admin=<pass>`）を開いたままにしておく必要があります**。閉じるとアップロード待機が `'uploaded'` 通知を受けられず、各試行が 120 秒タイムアウトで進行します。

**対処**: 実験中はメイン Admin タブを開いたままにし、Agent Admin（`?admin=agent`）は別タブで操作する。

---

## 関連ドキュメント

- [README.md](./README.md) — 機能概要・使い方
- [LOCAL_DEV.md](./LOCAL_DEV.md) — ローカル開発環境セットアップ
- [CLAUDE.md](./CLAUDE.md) — コードベース構造リファレンス
- [packages/web/supabase_schema.sql](./packages/web/supabase_schema.sql) — スキーマ定義（CREATE + ALTER 両方含む）
