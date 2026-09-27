# DB Change Log

ローカル開発用Supabase（Docker）のスキーマ変更履歴。別マシンで`docker volume`を保持したまま開発を引き継ぐ場合、このログの`未適用`の変更を上から順に手動適用してください。

新規にボリュームを作る場合（`npm run dev:docker:reset && npm run dev:docker`）は、`supabase/init/01-schema.sql`が初回起動時に最新スキーマを適用するため、このログの作業は不要です。

---

## 2026-05-06 — 録画ファイル名構築用カラムを追加

### 背景

各録画 (= 1試行) のダウンロード時に、ファイル名に「日付・タスク名・参加人数・試行番号・カーソル表示モード」を含められるよう、`recordings` に3列を追加した。アンダースコア区切りで `{date}_{task}_{count}_{trial}_{mode}.json` の形式にし、後段でsplit→集計しやすくする。

### 追加カラム (`recordings` テーブル)

| カラム | 型 | デフォルト | 用途 |
|---|---|---|---|
| `task_type` | `TEXT NOT NULL` | `''` | `ExperimentTaskType` 文字列。`experiment_name`の接頭辞ではなく独立列にした方がスキーマ非依存で抽出しやすい |
| `display_mode` | `TEXT NOT NULL` | `'avgOnly'` | 試行中の `DisplayMode` (`'avgOnly'` / `'self-with-avg'` / `'self'` / `'all-with-avg-no-lines'` ほか) |
| `participant_count` | `INTEGER NOT NULL` | `0` | 試行開始時点の非adminルーム参加者数。グループ実験は`group_assignments`から導出可能だが、非グループ実験では別途必要 |

### 適用SQL

```bash
docker exec livekit-cursor_mesh-db-1 psql -U postgres -d postgres -c \
  "ALTER TABLE recordings ADD COLUMN IF NOT EXISTS task_type TEXT NOT NULL DEFAULT '';"

docker exec livekit-cursor_mesh-db-1 psql -U postgres -d postgres -c \
  "ALTER TABLE recordings ADD COLUMN IF NOT EXISTS display_mode TEXT NOT NULL DEFAULT 'avgOnly';"

docker exec livekit-cursor_mesh-db-1 psql -U postgres -d postgres -c \
  "ALTER TABLE recordings ADD COLUMN IF NOT EXISTS participant_count INTEGER NOT NULL DEFAULT 0;"

docker exec livekit-cursor_mesh-db-1 psql -U postgres -d postgres -c \
  "NOTIFY pgrst, 'reload schema';"
```

### 動作確認

```bash
docker exec livekit-cursor_mesh-db-1 psql -U postgres -d postgres -c \
  "SELECT column_name, data_type, column_default FROM information_schema.columns
   WHERE table_name='recordings' AND column_name IN ('task_type','display_mode','participant_count')
   ORDER BY column_name;"
# → 3行返ってくればOK

curl -s "http://localhost:54321/rest/v1/recordings?select=task_type,display_mode,participant_count&limit=1"
# → "[]" または既存データが返ればOK
```

### 既存録画への影響

新規列は`DEFAULT`値で埋まる。古い録画は `task_type=''`, `display_mode='avgOnly'`, `participant_count=0`。ダウンロード側は空文字を `'unknown'` にフォールバック。

---

## 2026-05-06 — グループ実験用カラムを追加

### 背景

コミット`72fe47b` (2026-05-05) で`group-circle-target-tracking`タスクが追加され、`recordings`に2列、`frames`に1列のJSONB/INTEGERカラムが必要になった。リポジトリ内のスキーマファイル（`supabase/init/01-schema.sql` と `packages/web/supabase_schema.sql`）は更新済みだが、**Docker initスクリプトは空ボリュームの初回起動時のみ実行される**ため、既存ボリュームには反映されない。

詳細はDEPLOY.md「1. Supabase Cloud — スキーマ移行」を参照。

### 追加カラム

| テーブル | カラム | 型 | デフォルト | 説明 |
|---|---|---|---|---|
| `recordings` | `group_assignments` | `JSONB NOT NULL` | `'{}'::jsonb` | 録画開始時点の`{identity → groupId}` |
| `recordings` | `group_count` | `INTEGER NOT NULL` | `1` | グループ数（1 = グループなし） |
| `frames` | `group_averages` | `JSONB NOT NULL` | `'{}'::jsonb` | 各フレームの`{groupId → {x, y}}` |

### 適用SQL（既存ローカルDBへの手動適用用）

`docker compose ps` で`livekit-cursor_mesh-db-1`が起動中であることを確認したうえで、以下を実行：

```bash
docker exec livekit-cursor_mesh-db-1 psql -U postgres -d postgres -c \
  "ALTER TABLE recordings ADD COLUMN IF NOT EXISTS group_assignments JSONB NOT NULL DEFAULT '{}'::jsonb;"

docker exec livekit-cursor_mesh-db-1 psql -U postgres -d postgres -c \
  "ALTER TABLE recordings ADD COLUMN IF NOT EXISTS group_count INTEGER NOT NULL DEFAULT 1;"

docker exec livekit-cursor_mesh-db-1 psql -U postgres -d postgres -c \
  "ALTER TABLE frames ADD COLUMN IF NOT EXISTS group_averages JSONB NOT NULL DEFAULT '{}'::jsonb;"

# PostgRESTのスキーマキャッシュをリロード（これを忘れるとPGRST204エラーが出る）
docker exec livekit-cursor_mesh-db-1 psql -U postgres -d postgres -c \
  "NOTIFY pgrst, 'reload schema';"
```

`IF NOT EXISTS`付きなので再実行しても安全（idempotent）。

### 動作確認

```bash
# DBレベルでカラムが存在するか
docker exec livekit-cursor_mesh-db-1 psql -U postgres -d postgres -c \
  "SELECT table_name, column_name, data_type, column_default
   FROM information_schema.columns
   WHERE column_name LIKE 'group%' AND table_name IN ('recordings', 'frames')
   ORDER BY table_name, column_name;"
# → 3行返ってくればOK

# PostgREST API経由で見えるか
curl -s "http://localhost:54321/rest/v1/recordings?select=group_count,group_assignments&limit=1"
# → "[]" または既存データの行が返ればOK。"column ... does not exist"が出たらキャッシュリロードを再実行。
```

### 既存録画データへの影響

新規カラムは`DEFAULT`値で自動的に埋まるため、既存録画は壊れない。リプレイは`group_count = 1`の分岐を通り従来通り動作する。
