# Aeterna — 死後も動き続ける意志エージェント

## 概要

Aeternaは、生前に登録した人格・価値観・条件をもとに、AIエージェントが世界を監視し続け、
来るべきときに暗号資産を自律分配するシステムです。

**人間の介在ゼロ。死後も動き続ける意志エージェント。**

## エージェント起動方法

```bash
# 必要な環境変数を設定
cp .env.example .env
# .envを編集: ANTHROPIC_API_KEY, XRPL_NETWORK

# エージェント起動（自律ループ開始）
node agent/index.js
```

起動後、以下が自動で実行されます：
1. XRPLウォレットの自動生成（初回のみ）
2. 30秒ごとに世界のニュースを監視
3. Claude APIが人格データをもとに送金判断
4. トリガー条件成立時にXRPL testnetへ自動送金
5. 実行ログをlogs/log.jsonに記録

## 人格登録手順

`data/persona.json` を編集して人格を設定します：

```json
{
  "name": "あなたの名前",
  "values": "大切にしていた価値観（例：環境問題を最優先にする）",
  "trigger_keywords": ["キーワード1", "キーワード2"],
  "recipients": [
    {
      "name": "送金先名称",
      "wallet": "XRPLウォレットアドレス",
      "ratio": 0.6,
      "cause": "支援の目的"
    }
  ],
  "total_xrp": 10,
  "status": "active",
  "cooldown_minutes": 60
}
```

## API エンドポイント（ポート3001）

| Method | Path | 説明 |
|--------|------|------|
| GET | /api/persona | 人格データを取得 |
| GET | /api/logs | 実行ログを取得 |
| POST | /api/trigger | 手動でエージェントを起動（デモ用） |
| GET | /api/status | エージェント稼働状態を取得 |

## デモシナリオ

1. `node agent/index.js` を実行
2. エージェントが自律起動、30秒後に最初の判断
3. 「海面上昇」「気候変動」関連ニュースを検知
4. Claude APIが判断：「この人格ならWWF Japanへ送金」
5. XRPL testnetで自動送金実行
6. 判断理由を故人の言葉で出力
7. XRPLトランザクションリンクを表示
8. logs/log.jsonに実行ログ追記

## 技術スタック

- **Runtime**: Node.js
- **AIエージェント**: OpenClaw（heartbeat/cronで自律ループ）
- **判断エンジン**: Claude API（@anthropic-ai/sdk, claude-haiku-4-5）
- **ブロックチェーン**: XRPL testnet（xrpl.js）
- **データ**: ローカルJSON
- **スケジューラ**: node-cron（30秒間隔）
- **API**: Express.js（ポート3001）

## ファイル構成

```
agent/
  index.js    # 自律ループのメイン + Expressサーバー
  judge.js    # Claude API判断エンジン
data/
  persona.json  # 人格・条件・分配先データ
  wallet.json   # XRPLウォレット（自動生成、gitignore）
xrpl/
  send.js     # XRPL送金モジュール
logs/
  log.json    # 実行ログ
```
