# Aeterna — OpenClaw Autonomous Will Agent

死後も動き続ける意志エージェント。生前に登録した人格・価値観・条件をもとに、
AIが世界を監視し、来るべきときに暗号資産を自律分配する。

## Architecture

```
OpenClaw (Claude Code)
    ↓ reads SKILL.md & persona.json
    ↓ fetches world news (web_fetch)
    ↓ judges based on persona values
    ↓ triggers XRPL transfer via API
XRPL testnet ← automated settlement
```

## Quick Start

```bash
# 1. Setup
cp .env.example .env   # set ANTHROPIC_API_KEY
npm install

# 2. Run autonomous agent (node-cron loop every 30s)
node agent/index.js

# 3. Run as OpenClaw skill (Claude Code drives the agent)
# In Claude Code: invoke the "aeterna" skill
```

## Key Commands

| Command | Description |
|---------|-------------|
| `node agent/index.js` | Start autonomous agent + API server (port 3001) |
| `node agent/judge.js` | Test Claude judgment engine standalone |
| `node xrpl/send.js` | Test XRPL send module standalone |

## API Endpoints (port 3001)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/persona` | Get persona data |
| GET | `/api/logs` | Get execution logs |
| POST | `/api/trigger` | Manually trigger one agent cycle |
| GET | `/api/status` | Get agent status |

## Persona Configuration

Edit `data/persona.json` to register a will:
- `values`: What the person cared about
- `trigger_keywords`: Keywords that activate distribution
- `recipients`: Who receives XRP and how much
- `total_xrp`: Total budget in XRP
- `status`: `"active"` to enable

## OpenClaw Skill

This project exposes an OpenClaw skill at `skills/aeterna/SKILL.md`.

When Claude Code (OpenClaw) is running, it can autonomously:
1. Read the persona and understand the will
2. Fetch relevant world news
3. Judge whether the trigger condition is met
4. POST to `/api/trigger` to execute the XRPL transaction

## Tech Stack

- **Agent Brain**: Claude API (`claude-haiku-4-5`) + OpenClaw skill
- **Blockchain**: XRPL testnet (xrpl.js)
- **Scheduler**: node-cron (30s interval)
- **API**: Express.js
- **Data**: Local JSON
