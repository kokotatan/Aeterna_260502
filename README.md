# Aeterna — 死後も動き続ける意志エージェント

> 生前に登録した人格・価値観・条件をもとに、AIエージェントが世界を監視し続け、来るべきときに暗号資産を自律分配する。人間の介在ゼロ。死後も動き続ける意志エージェント。

**OpenClaw Hackathon Tokyo Edition 2026/5/2**

---

## セットアップ

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を編集:

```
ANTHROPIC_API_KEY=your_anthropic_api_key_here
XRPL_NETWORK=wss://s.altnet.rippletest.net:51233
PORT=3001
```

### 3. テストネット初期化（初回のみ・必須）

```bash
npm run setup
```

これにより：
- 送金用ウォレットを自動生成（faucetから1000 XRP付与）
- 受取人用ウォレットを2つ生成（実在するtestnetアドレス）
- `data/persona.json` の受取人アドレスを自動更新

---

## デモ実行

```bash
npm start
```

### 実行の流れ

1. XRPLウォレットを自動生成（初回のみ `data/wallet.json` に保存）
2. 30秒ごとに自律ループ起動
3. ニュースをフェッチ（NewsAPI or シミュレーション）
4. Claude APIが人格データと照合して送金判断
5. トリガー成立 → XRPL testnetへ自動送金
6. 判断理由をコンソールに表示
7. XRPLトランザクションリンクを出力
8. `logs/log.json` に記録

### 期待される出力例

```
[AGENT] Aeterna autonomous agent starting...
[AGENT] Will monitor world events every 30 seconds.
[AGENT] ====== Cycle started at 2026-05-02T10:00:00.000Z ======
[AGENT] Running Claude judgment...
[AGENT] Judgment: triggered=true
[AGENT] Reason: 海面上昇による危機が報告されています。私の意志に従い、環境保護団体への支援を実行します。

╔══════════════════════════════════════╗
║   AETERNA — 意志の実行完了            ║
╠══════════════════════════════════════╣
║ 判断理由: 海面上昇による危機が報告され...
║ → WWF Japan: 6 XRP
║   TX: A1B2C3D4E5F6...
╚══════════════════════════════════════╝

[AGENT] ✓ Explorer: https://testnet.xrpl.org/transactions/...
```

---

## API エンドポイント

エージェント起動後、ポート3001でAPIが利用可能になります。

| Method | Path | 説明 |
|--------|------|------|
| `GET` | `/api/persona` | 人格データを取得 |
| `GET` | `/api/logs` | 実行ログを取得 |
| `POST` | `/api/trigger` | 手動でエージェントを起動（デモ用） |
| `GET` | `/api/status` | エージェント稼働状態を取得 |

```bash
# 手動トリガー（デモ時）
curl -X POST http://localhost:3001/api/trigger

# ログ確認
curl http://localhost:3001/api/logs

# 人格データ確認
curl http://localhost:3001/api/persona
```

---

## 個別モジュールのテスト

```bash
# XRPL送金モジュールのテスト
node xrpl/send.js

# Claude判断エンジンのテスト
node agent/judge.js
```

---

## 技術スタック

| 役割 | 技術 |
|------|------|
| AIエージェントフレームワーク | OpenClaw |
| 判断エンジン | Claude API (`claude-haiku-4-5`) |
| ブロックチェーン | XRPL testnet |
| ランタイム | Node.js |
| スケジューラ | node-cron |
| APIサーバー | Express.js |
| データ | ローカルJSON |

---

## ディレクトリ構成

```
Aeterna_260502/
├── agent/
│   ├── index.js      # 自律ループ + Express APIサーバー
│   └── judge.js      # Claude API判断エンジン
├── data/
│   └── persona.json  # 人格・条件・分配先データ
├── xrpl/
│   └── send.js       # XRPL送金モジュール
├── skills/
│   └── aeterna/
│       └── SKILL.md  # OpenClawスキル定義
├── logs/
│   └── log.json      # 実行ログ
├── .env.example      # 環境変数テンプレート
└── README.md
```

---

## XRPLトランザクション確認

送金後、コンソールに表示されるURLでXRPL testnetのトランザクションを確認できます:

```
https://testnet.xrpl.org/transactions/{TX_HASH}
```

Memoフィールドに判断理由が記録されます。
