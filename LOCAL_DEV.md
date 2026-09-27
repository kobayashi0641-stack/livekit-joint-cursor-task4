# ローカル開発ガイド

このドキュメントは、LiveKit Cursor Mesh をローカル環境で開発・テストするための手順をまとめたものです。

---

## 目次

1. [前提条件](#1-前提条件)
2. [依存関係のインストール](#2-依存関係のインストール)
3. [環境変数の設定](#3-環境変数の設定)
4. [サーバーとWebアプリの起動](#4-サーバーとwebアプリの起動)
5. [動作確認（スモークテスト）](#5-動作確認スモークテスト)
6. [各種管理画面へのアクセス](#6-各種管理画面へのアクセス)
7. [エージェント管理画面（Agent Admin）](#7-エージェント管理画面agent-admin)
8. [複数参加者のシミュレーション](#8-複数参加者のシミュレーション)
9. [ローカルSupabase（Docker）— 任意](#9-ローカルsupabasedocker-任意)
10. [プロダクションビルド](#10-プロダクションビルド)
11. [Renderへのデプロイ](#11-renderへのデプロイ)
12. [よくあるトラブル](#12-よくあるトラブル)
13. [ローカル環境と本番環境の違い](#13-ローカル環境と本番環境の違い)
14. [リポジトリの主要スクリプト](#14-リポジトリの主要スクリプト)

---

## 1. 前提条件

- **Node.js** 20 以上
- **LiveKit Cloud** の認証情報（API Key / API Secret / WebSocket URL）
  - [LiveKit Cloud](https://cloud.livekit.io/) でプロジェクトを作成し、認証情報を取得してください
- **Docker & Docker Compose**（任意 — ローカルSupabaseを使う場合のみ）

> **ポイント**: Docker は必須ではありません。カーソル共有やエージェント機能は Docker なしで動作します。Docker が必要なのは、録画データをローカルの Supabase に保存したい場合のみです（設定しない場合は本番の Supabase Cloud にフォールバックします）。

---

## 2. 依存関係のインストール

```bash
cd liveKit-cursor_mesh
npm install
```

---

## 3. 環境変数の設定

### 3.1 トークンサーバー（`packages/server/.env`）

テンプレートからファイルをコピーし、実際の値を設定します。

```bash
cp packages/server/.env.example packages/server/.env
```

`packages/server/.env` を開き、LiveKit Cloud の認証情報を入力してください:

```dotenv
LIVEKIT_API_KEY=<LiveKit Cloud の API Key>
LIVEKIT_API_SECRET=<LiveKit Cloud の API Secret>
LIVEKIT_WS_URL=wss://<your-project>.livekit.cloud
PORT=3001
TOKEN_TTL_SECONDS=600
ADMIN_PASSWORD=<管理者パスワード>
```

| 変数名 | 必須 | 説明 | デフォルト |
|--------|------|------|-----------|
| `LIVEKIT_API_KEY` | はい | LiveKit Cloud の API Key | — |
| `LIVEKIT_API_SECRET` | はい | LiveKit Cloud の API Secret | — |
| `LIVEKIT_WS_URL` | はい | LiveKit Cloud の WebSocket URL（`wss://...`） | — |
| `PORT` | いいえ | サーバーのポート番号 | `3001` |
| `TOKEN_TTL_SECONDS` | いいえ | トークンの有効期間（秒） | `600`（10分） |
| `ADMIN_PASSWORD` | いいえ | 管理者パスワード | — |

> **重要**: ローカル開発でも、実際の LiveKit Cloud の API Key / Secret を使用してください。LiveKit Cloud はサードパーティの SaaS（SFU サーバー）であり、ローカルにホストできません。ローカルのサーバーと Web アプリは LiveKit Cloud に接続してリアルタイム通信を行います。
>
> 本番環境と同じ API キーを使う場合、ルーム名がデフォルトで `joint-cursor-task2` になるため、本番環境と同じルームに接続されます。本番と分離したい場合は、ローカルでは別のルーム名（例: `joint-cursor-task2-dev`）を使うことをお勧めします。

### 3.2 Webアプリ（`packages/web/.env.local`）— 任意

通常はこの設定は不要です（デフォルトでローカルのトークンサーバーに接続します）。ローカル Docker Supabase を使う場合のみ設定してください。

```bash
cp packages/web/.env.local.example packages/web/.env.local
```

```dotenv
VITE_TOKEN_SERVER=http://localhost:3001
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=<ローカルSupabaseのanon key（.env.local.example参照）>
```

> `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` を設定しない場合、アプリは自動的に本番の Supabase Cloud インスタンスにフォールバックします。

---

## 4. サーバーとWebアプリの起動

2つのターミナルを開いて、それぞれ起動します。

```bash
# ターミナル1 — トークンサーバー（Express）
npm run dev:server
```

```bash
# ターミナル2 — Webアプリ（Vite開発サーバー）
npm run dev:web
```

起動が完了すると:
- トークンサーバー: **http://localhost:3001**
- Webアプリ: **http://localhost:5173**

### サーバーの起動確認

```bash
curl http://localhost:3001/healthz
# => {"status":"ok"}

curl "http://localhost:3001/token?room=joint-cursor-task2"
# => JWT トークンと LiveKit URL が返る
```

> **別の起動方法（ビルドして起動）**:
> ```bash
> npm run build --workspace=@cursor/server
> npm run start --workspace=@cursor/server
> ```
>
> **直接実行する場合**:
> ```bash
> node --env-file=packages/server/.env packages/server/dist/index.js
> ```

---

## 5. 動作確認（スモークテスト）

1. ブラウザで `http://localhost:5173` を開く
2. 接続パラメータを入力（通常はデフォルトのまま）:
   - Token server: `http://localhost:3001`
   - Room: `joint-cursor-task2`（任意）
   - Identity: 空でもOK（サーバーが自動生成）
3. 「Connect」をクリック
4. 白いステージ内でマウスを動かすと、自分のカーソルが表示されます

**複数クライアントでのテスト**:
- ブラウザを2つのウィンドウで開き、両方で「Connect」
- ステージ内でマウスを動かし、以下を確認:
  - 相互にカーソルが見える
  - 参加者数が増える
  - 平均カーソル（Avg）が動く
- 「Disconnect」ボタンで切断できることを確認

---

## 6. 各種管理画面へのアクセス

| 画面 | URL | 説明 |
|------|-----|------|
| 管理者（Admin） | `http://localhost:5173/?admin=<ADMIN_PASSWORD>` | 実験制御、録画、参加者監視 |
| エージェント管理 | `http://localhost:5173/?admin=agent` | 実験フローの自動化設定 |
| 参加者（テスト用） | `http://localhost:5173/?PROLIFIC_PID=test1` | 参加者としてテスト |
| ダミーカーソル | `http://localhost:5173/?PROLIFIC_PID=dummy1&dummy=1` | 自動で動くダミー参加者 |
| DBビューア | `http://localhost:5173/?admin=database` | データベース管理 |
| ビューア | `http://localhost:5173/?admin=viewer` | 閲覧専用モード |

---

## 7. エージェント管理画面（Agent Admin）

エージェント機能を使って、実験フロー（参加者待機 → インストラクション表示 → タスク開始 → Yes/No確認 → セッション終了）を自動化できます。

### 7.1 エージェントのアーキテクチャ

**重要**: エージェントは LiveKit ルームに「参加者」として参加しません。サーバーサイドの `RoomServiceClient`（LiveKit HTTP API）を使って、ルーム外からコントロールメッセージを送信します。そのため:
- 参加者リストにエージェントは表示されない
- エージェントはカーソルを持たない
- エージェントは既存の Express サーバープロセス内で動作する（追加のサーバー不要）
- ブラウザを閉じてもエージェントはサーバー上で実行を継続する

```
管理者ブラウザ (?admin=agent)
    │
    ├── POST /agent/start      → エージェント開始
    ├── POST /agent/stop       → エージェント停止
    ├── POST /agent/reset      → エージェントリセット
    ├── GET  /agent/status     → ステータス取得
    ├── GET  /agent/rules      → ルール取得
    └── POST /agent/rules      → ルール更新
                │
                ▼
    Express Server (ExperimentAgent)
        │
        ├── RoomServiceClient.listParticipants() → 参加者数の確認
        ├── RoomServiceClient.sendData()         → コントロールメッセージ送信
        │     ├── CONTROL_TOPIC: 表示モード、Yes/No、セッション終了
        │     └── BROADCAST_TOPIC: インストラクション表示
        │
        └── POST /agent/area-report ← 参加者からのカーソルエリア報告
```

### 7.2 アクセス方法

```
http://localhost:5173/?admin=agent
```

アクセスすると管理者パスワードの入力を求められます。`packages/server/.env` の `ADMIN_PASSWORD` に設定した値を入力してください。

URL にパスワードを含めて自動認証することもできます:

```
http://localhost:5173/?admin=agent&password=<ADMIN_PASSWORD>
```

### 7.3 エージェントの基本操作

1. **ルール設定**: 管理画面でルールを追加・編集・並べ替え・削除し、「Save Rules」で保存
2. **開始**: 「Start Agent」をクリック → エージェントがルールを順番に自動実行
3. **監視**: ステータス、現在のステップ、参加者数、経過時間をリアルタイム表示
4. **停止/リセット**: 「Stop Agent」で即座に停止、「Reset Agent」で初期状態に戻す

### 7.4 ローカルでのエージェントテスト手順

```bash
# ターミナル1 — サーバー起動
npm run dev:server

# ターミナル2 — Web起動
npm run dev:web

# ターミナル3 — ダミー参加者を起動（3人）
npm run simulate:browser
# または
bash scripts/open-participants.sh 3
```

1. ブラウザで `http://localhost:5173/?admin=agent` を開く
2. 管理者パスワードを入力してログイン
3. テスト用に簡単なルールを設定:
   - `waitForParticipants` (minParticipants: 1, timeoutMinutes: 1)
   - `showInstruction` ("テスト開始", 3000ms)
   - `endSession`
4. 「Save Rules」→「Start Agent」で実行
5. 参加者タブで実験フローが自動実行されることを確認

### 7.5 ルールタイプ一覧

エージェントは以下の9種類のルールをサポートしています。ルールは設定された順番に上から順に実行されます。

#### 1. `waitForParticipants` — 参加者待機

指定した人数の参加者が集まるまで待機します。タイムアウトに達した場合は、現在の人数で次のステップに進みます。

| パラメータ | 型 | 説明 | デフォルト |
|-----------|-----|------|-----------|
| `minParticipants` | number | 最低参加者数 | 10 |
| `timeoutMinutes` | number | タイムアウト（分） | 15 |

```json
{ "type": "waitForParticipants", "minParticipants": 10, "timeoutMinutes": 15 }
```

#### 2. `showInstruction` — インストラクション表示

全参加者の画面にメッセージを表示します。

| パラメータ | 型 | 説明 | デフォルト |
|-----------|-----|------|-----------|
| `text` | string | 表示するメッセージ | — |
| `durationMs` | number | 表示時間（ミリ秒） | 5000 |
| `waitForDuration` | boolean | 表示終了を待ってから次へ | true |

```json
{ "type": "showInstruction", "text": "実験を開始します", "durationMs": 5000, "waitForDuration": true }
```

#### 3. `setDisplayMode` — 表示モード変更

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `mode` | string | 表示モード |

利用可能なモード: `all-without-avg`, `all-with-avg-lines`, `all-with-avg-no-lines`, `avgOnly`, `self`

#### 4. `setTaskMode` — タスクモード変更

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `taskMode` | string | タスクモード |

利用可能なモード: `target-tracking`, `manual-instruction`, `circle-target-tracking`, `guide-tracking`, `random-target-tracking`

#### 5. `showYesNoAreas` — Yes/Noエリア表示

Yes/No エリアを表示し、参加者のカーソルが指定エリア内に入るのを待ちます。

| パラメータ | 型 | 説明 | デフォルト |
|-----------|-----|------|-----------|
| `requiredArea` | `'yes'` / `'no'` / `'any'` | 確認するエリア | `'yes'` |
| `requiredRatio` | number | 必要な参加者の割合（0.0〜1.0） | 0.8 |
| `timeoutSeconds` | number | タイムアウト（秒） | 60 |

```json
{ "type": "showYesNoAreas", "requiredArea": "yes", "requiredRatio": 0.8, "timeoutSeconds": 60 }
```

#### 6. `hideYesNoAreas` — Yes/Noエリア非表示

パラメータなし。

#### 7. `wait` — 待機

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `durationSeconds` | number | 待機時間（秒） |

#### 8. `setCursorVisibility` — カーソル表示/非表示

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `hideCursor` | boolean | `true` で非表示、`false` で表示 |

#### 9. `endSession` — セッション終了

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `completionUrl` | string（任意） | リダイレクト先URL。省略時は Prolific デフォルト URL |

### 7.6 ルール設定の実用例

#### 例1: シンプルな実験

```json
[
  { "type": "waitForParticipants", "minParticipants": 5, "timeoutMinutes": 10 },
  { "type": "showInstruction", "text": "実験を開始します", "durationMs": 3000, "waitForDuration": true },
  { "type": "setDisplayMode", "mode": "all-without-avg" },
  { "type": "setTaskMode", "taskMode": "target-tracking" },
  { "type": "wait", "durationSeconds": 120 },
  { "type": "showInstruction", "text": "お疲れ様でした", "durationMs": 5000, "waitForDuration": true },
  { "type": "endSession" }
]
```

#### 例2: 同意確認付きの実験

```json
[
  { "type": "waitForParticipants", "minParticipants": 10, "timeoutMinutes": 15 },
  { "type": "showInstruction", "text": "同意される方はYesエリアにカーソルを移動してください", "durationMs": 8000, "waitForDuration": true },
  { "type": "showYesNoAreas", "requiredArea": "yes", "requiredRatio": 0.9, "timeoutSeconds": 60 },
  { "type": "hideYesNoAreas" },
  { "type": "showInstruction", "text": "確認ありがとうございます。実験を開始します。", "durationMs": 3000, "waitForDuration": true },
  { "type": "setDisplayMode", "mode": "all-with-avg-lines" },
  { "type": "setTaskMode", "taskMode": "target-tracking" },
  { "type": "wait", "durationSeconds": 180 },
  { "type": "endSession" }
]
```

### 7.7 新しいルールタイプの追加方法

新しいルールタイプを追加するには、以下の手順に従ってください。

**ステップ1**: `packages/server/src/agent-rules.ts` に新しいルール型を定義

```typescript
export type MyNewRule = {
  type: 'myNewRule';
  someParam: string;  // パラメータを定義
};
```

**ステップ2**: `AgentRule` ユニオン型に追加

```typescript
export type AgentRule =
  | WaitForParticipantsRule
  | ... // 既存のルール
  | MyNewRule;
```

**ステップ3**: `describeRule()` 関数にケースを追加

**ステップ4**: `packages/server/src/agent.ts` の `ExperimentAgent` クラスに実行ロジックを追加

```typescript
private async execMyNewRule(someParam: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  // ルールのロジックを実装
}
```

**ステップ5**: `executeRule()` メソッドの switch 文に追加

**ステップ6**: `packages/web/src/AgentAdmin.tsx` に UI（エディタとフォーム）を追加

> **注意**: ルールの型定義はサーバー (`agent-rules.ts`) とフロントエンド (`AgentAdmin.tsx`) で重複しています。新しいルールタイプを追加する場合は、必ず両方のファイルを更新してください。

### 7.8 エージェント関連ファイル

| ファイル | 説明 |
|---------|------|
| `packages/server/src/agent-rules.ts` | ルールの型定義とデフォルトルール |
| `packages/server/src/agent.ts` | `ExperimentAgent` クラス（実行エンジン） |
| `packages/server/src/index.ts` | REST API エンドポイント |
| `packages/web/src/AgentAdmin.tsx` | 管理 UI（React） |

### 7.9 エージェント API エンドポイント

全てのエンドポイントは管理者パスワードによる認証が必要です（`area-report` を除く）。

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/agent/status?adminPassword=XXX` | ステータス取得 |
| `GET` | `/agent/rules?adminPassword=XXX` | ルール一覧取得 |
| `POST` | `/agent/rules` | ルール更新（body: `{ adminPassword, rules }`） |
| `POST` | `/agent/start` | エージェント開始（body: `{ adminPassword }`） |
| `POST` | `/agent/stop` | エージェント停止（body: `{ adminPassword }`） |
| `POST` | `/agent/reset` | エージェントリセット（body: `{ adminPassword }`） |
| `POST` | `/agent/area-report` | カーソルエリア報告（認証不要、body: `{ identity, area }`） |

---

## 8. 複数参加者のシミュレーション

### 方法A: ヘッドレスボット（負荷テスト向け）

`@livekit/rtc-node` を使ったヘッドレス参加者を作成し、カーソルデータを送信します。

```bash
# 5体のボット（デフォルト）
npm run simulate

# 任意の数のボット
npm run simulate -- --count 10

# 全オプション指定
npm run simulate -- --count 10 --server http://localhost:3001 --room joint-cursor-task2
```

各ボットはノイズ付きの円軌道を描きます。

### 方法B: ブラウザタブ（リアルなUIテスト向け）

実際のブラウザウィンドウを開き、それぞれが別々の参加者として接続します。

```bash
# 3タブ（デフォルト）
npm run simulate:browser

# 任意の数のタブ
bash scripts/open-participants.sh 5
```

---

## 9. ローカルSupabase（Docker）— 任意

録画データをローカルのデータベースに保存したい場合は、Docker で Supabase 互換スタックを起動できます。

> **この手順は任意です。** Supabase を起動しなくても、カーソル共有やエージェント機能は正常に動作します。Docker セットアップが必要なのは、録画データをローカルに保存・確認したい場合のみです。設定しない場合は自動的に本番の Supabase Cloud にフォールバックします。

### 9.1 前提条件

- **Docker Desktop**（Mac / Windows）または **Docker Engine + Docker Compose**（Linux）
  - Mac: https://docs.docker.com/desktop/install/mac-install/
  - Windows: https://docs.docker.com/desktop/install/windows-install/
  - Linux: https://docs.docker.com/engine/install/
- Docker デーモンが起動していること

```bash
# Docker が利用可能か確認
docker --version
# => Docker version 24.x.x 以上

docker compose version
# => Docker Compose version v2.x.x 以上
```

### 9.2 アーキテクチャ

ローカル Supabase スタックは以下の3つのコンテナで構成されています:

```
ブラウザ (Webアプリ)
    │
    └── HTTP リクエスト（@supabase/supabase-js）
            │
            ▼
    Kong API Gateway (port 54321)
        │
        └── /rest/v1/* → PostgREST (port 3000, コンテナ内部)
                              │
                              └── PostgreSQL (port 54322)
                                    ├── anon ロール（RLS で制御）
                                    ├── recordings テーブル
                                    ├── frames テーブル
                                    ├── events テーブル
                                    └── broadcast_messages テーブル
```

| コンテナ | イメージ | 役割 | 外部ポート |
|---------|---------|------|-----------|
| `db` | `postgres:15-alpine` | データベース本体 | `54322` |
| `rest` | `postgrest/postgrest:v12.0.1` | PostgreSQL → REST API 変換 | — (内部のみ) |
| `kong` | `kong:3.4` | API ゲートウェイ（Supabase API 互換） | `54321` |

### 9.3 起動

```bash
npm run dev:docker
```

これは内部的に `docker compose up -d` を実行します。初回はイメージのダウンロードに数分かかります。

初回起動時に、以下が自動的に実行されます:
1. PostgreSQL のデータベースロール作成（`supabase/init/00-roles.sql`）
   - `anon`, `authenticated`, `service_role`, `authenticator` ロール
2. データベーススキーマの適用（`supabase/init/01-schema.sql`）
   - `recordings`, `frames`, `events`, `broadcast_messages` テーブル
   - 各テーブルのインデックスと RLS ポリシー

### 起動確認

```bash
# コンテナの状態を確認
docker compose ps

# 全コンテナが "running" かつ db が "healthy" であること:
#   NAME       STATUS
#   db         running (healthy)
#   rest       running
#   kong       running

# API にリクエストを送って確認
curl http://localhost:54321/rest/v1/recordings
# => [] (空の配列が返れば正常)
```

### 9.4 Web アプリの設定

ローカル Supabase を使う場合は、`packages/web/.env.local` を作成して以下を設定してください:

```bash
cp packages/web/.env.local.example packages/web/.env.local
```

`.env.local.example` には以下の値が既に記載されています:

```dotenv
VITE_TOKEN_SERVER=http://localhost:3001
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
```

> **注意**: 上記の `VITE_SUPABASE_ANON_KEY` はローカル開発用のデモ JWT です。本番の秘密鍵ではなく、ローカル Docker スタックでのみ動作します。そのままコピーして使ってください。

設定後、Web アプリを再起動してください:
```bash
# Ctrl+C で停止してから再起動
npm run dev:web
```

### 9.5 停止

```bash
npm run dev:docker:stop
```

データは Docker ボリューム（`db_data`）に保持されるため、再起動してもデータは残ります。

### 9.6 停止してデータ削除

```bash
npm run dev:docker:reset
```

これは `docker compose down -v` を実行し、Docker ボリュームを含めて全て削除します。次回起動時にスキーマが再適用され、空のデータベースから始まります。

### 9.7 データベースへの直接接続

PostgreSQL に直接接続してデータを確認したい場合:

```bash
# psql で接続（Docker コンテナ内の psql を使用）
docker compose exec db psql -U postgres

# または、ローカルに psql がインストールされている場合
psql -h localhost -p 54322 -U postgres -d postgres
# パスワード: postgres
```

```sql
-- テーブル一覧の確認
\dt

-- 録画データの確認
SELECT * FROM recordings ORDER BY created_at DESC LIMIT 10;

-- フレームデータの確認（特定の録画）
SELECT COUNT(*) FROM frames WHERE recording_id = '<recording-uuid>';
```

### 9.8 ファイル構成

```
docker-compose.yml              # Docker Compose 定義
supabase/
  init/
    00-roles.sql                # PostgreSQL ロール作成（初回起動時に自動実行）
    01-schema.sql               # テーブル・インデックス・RLS ポリシー作成
  kong/
    kong.yml                    # Kong API ゲートウェイのルーティング設定
packages/web/
  .env.local.example            # Web アプリの環境変数テンプレート
  supabase_schema.sql           # スキーマの参考用コピー（本番と同じ）
```

### 9.9 ポートのカスタマイズ

デフォルトのポートが他のサービスと競合する場合は、環境変数で変更できます:

```bash
# PostgreSQL を 5433 で、API を 8000 で起動
POSTGRES_PORT=5433 SUPABASE_PORT=8000 npm run dev:docker
```

この場合、`packages/web/.env.local` も合わせて変更してください:
```dotenv
VITE_SUPABASE_URL=http://localhost:8000
```

### 9.10 よくあるトラブル（Docker）

#### `docker compose up` が失敗する
- Docker デーモンが起動しているか確認: `docker info`
- ポートが既に使われていないか確認: `lsof -i :54321` / `lsof -i :54322`

#### API が 502 / Connection refused を返す
- PostgREST が PostgreSQL の起動を待っている可能性があります。数秒待ってから再試行してください
- `docker compose logs rest` でログを確認

#### データベースにテーブルがない
- 初回起動時にスキーマが自動適用されます。テーブルがない場合は:
  ```bash
  # 一度リセットして再起動
  npm run dev:docker:reset
  npm run dev:docker
  ```

#### `anon key` が無効
- `.env.local` の `VITE_SUPABASE_ANON_KEY` が `.env.local.example` に記載されている値と一致しているか確認
- この JWT は `docker-compose.yml` の `PGRST_JWT_SECRET` と対応しています

---

## 10. プロダクションビルド

```bash
# サーバーのビルド（出力先: packages/server/dist）
npm run build --workspace=@cursor/server

# Webアプリのビルド（出力先: packages/web/dist）
npm run build --workspace=@cursor/web
```

Web からトークンサーバー URL を固定したい場合:

```bash
VITE_TOKEN_SERVER=http://localhost:3001 npm run build --workspace=@cursor/web
```

---

## 11. Renderへのデプロイ

`render.yaml` は「サーバー + ビルド済み Web を同一 Web Service で配信」する構成です。Static Site は使いません。

### 手順

1. リポジトリを GitHub にプッシュ
2. Render ダッシュボード → New → Blueprint → リポジトリを選択
3. 作成されるサービス:
   - `cursor-app`（Web Service / Node）
   - Build: `npm ci && npm run build --workspace=@cursor/web && npm run build --workspace=@cursor/server`
   - Start: `node packages/server/dist/index.js`
   - Web の静的ファイルはサーバーが自動配信
4. 環境変数の設定（Render ダッシュボードで Secret として設定）:
   - 必須: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_WS_URL`
   - 任意: `TOKEN_TTL_SECONDS`（デフォルト 600）, `ADMIN_PASSWORD`

### 動作確認

- 公開URLにアクセス → フロントが表示されます
- Token Server は同一オリジン `/token` を自動使用（フロント側で `VITE_TOKEN_SERVER` が未設定の場合は `window.location.origin` を既定にするよう実装済み）

### 注意事項

- Render の Web Service は `PORT` を自動割当するため、固定 PORT の設定は不要
- エージェント機能は既存のサーバープロセス内で動作するため、追加のサービスは不要
- CORS は同一オリジン配信のため不要（別オリジンから叩く場合は調整してください）

---

## 12. よくあるトラブル

### 401/403（トークン無効）
- `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` / `LIVEKIT_WS_URL` の値を再確認
- `LIVEKIT_WS_URL` は LiveKit Cloud の `wss://...livekit.cloud` を使用
- トークン TTL を短くしている場合、発行から接続までの遅延に注意

### 接続できない / CORS エラー
- サーバー側は `cors()` を有効化済み
- ブラウザのコンソール / ネットワークログでエラー内容を確認

### ポート競合（`EADDRINUSE`）
- `PORT`（サーバー側）または `vite.config.ts`（Web 側）を変更して回避

### エージェントが 403 を返す
- `packages/server/.env` に `ADMIN_PASSWORD` が設定されているか確認
- エージェント管理画面で入力するパスワードが `ADMIN_PASSWORD` と一致しているか確認

### Web 側のトークンサーバー URL を固定したい
- ビルド時に `VITE_TOKEN_SERVER` を指定:
  ```bash
  VITE_TOKEN_SERVER=http://localhost:3001 npm run build --workspace=@cursor/web
  ```

---

## 13. ローカル環境と本番環境の違い

| 項目 | 本番環境（Render） | ローカル |
|------|-------------------|---------|
| ホスティング | 単一の Render Web Service | Vite + Express の2プロセス |
| データベース | Supabase Cloud | Docker Supabase（任意）または Supabase Cloud |
| LiveKit | LiveKit Cloud | LiveKit Cloud（同じ） |
| 静的ファイル | Express が `web/dist` から配信 | Vite 開発サーバーが配信 |
| エージェント | Express プロセス内で動作 | Express プロセス内で動作（同じ） |

### ローカルアーキテクチャ図

```
ブラウザ (localhost:5173)
  ├── Vite 開発サーバー (HMR)
  ├── → トークンサーバー (localhost:3001)    [Express]
  ├── → LiveKit Cloud (WebRTC/SFU)          [wss://...]
  └── → ローカル Supabase (localhost:54321)  [Docker / 任意]
        ├── Kong (API gateway, port 54321)
        ├── PostgREST (REST API)
        └── PostgreSQL (port 54322)
```

---

## 14. リポジトリの主要スクリプト

| スクリプト | 説明 |
|-----------|------|
| `npm run dev:server` | トークンサーバーを開発モードで起動（ホットリロード） |
| `npm run dev:web` | Web アプリを開発モードで起動（Vite HMR） |
| `npm run build --workspace=@cursor/server` | サーバーをビルド |
| `npm run build --workspace=@cursor/web` | Web アプリをビルド |
| `npm run typecheck` | 全パッケージの型チェック |
| `npm run simulate` | ヘッドレスボットで参加者をシミュレート |
| `npm run simulate:browser` | ブラウザタブで参加者をシミュレート |
| `npm run dev:docker` | ローカル Supabase を Docker で起動 |
| `npm run dev:docker:stop` | ローカル Supabase を停止 |
| `npm run dev:docker:reset` | ローカル Supabase を停止してデータ削除 |
