<div align="center">

# 🍚 WeChat Pantry AI

**A shared fridge for two · AI meal planning · Household agent**

A WeChat Mini Program for couples: track what's in your fridge, and let AI tell you what you can cook tonight.

[![WeChat MiniProgram](https://img.shields.io/badge/WeChat-MiniProgram-07C160?logo=wechat&logoColor=white)](#)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](#)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[简体中文](README.md) | English

</div>

---

## 📖 Overview

**WeChat Pantry AI** (「我们的小家」/ "Our Little Home") is a real household tool shared by two people. The core loop is one sentence:

> What's in the fridge? → AI plans dishes from those ingredients → missing items go to the shopping cart → cooking a meal deducts stock and logs consumption.

It is not another recipe app. It's a small system **designed for two people living together**: both share the same inventory, and whoever buys something, orders a dish, or cooks a meal sees it reflected instantly on the other's phone.

**What it does**

- 🔍 **Ask in plain language**: what's in the fridge, what's about to expire, what's still missing this week
- 🍽️ **Expiry-first ranking**: dishes are scored on expiry urgency + stock coverage + variety, so the food that's about to go off gets used first
- 🗓️ **Weekly meal plan**: breakfast / lunch / dinner across the week, shortages computed automatically, one tap when you've cooked it
- 🧾 **AI intake**: photograph up to 9 items in one batch, or just say "I bought two pounds of ribs"
- 📊 **Nutrition tracking**: today's ring, three macros, 7-day trend — nutrition flows through from recipe to log
- 🧠 **Multi-turn memory**: the last 5 turns are carried, so "just plan it like you said" actually works
- 💬 **Casual chat**: it isn't only about the fridge — ask how to prepare something, or just talk

Built for **two people sharing a flat or a home**: one buys groceries and the other sees it, dish requests and who cooked what are on record, no more reconciling over chat apps.

<div align="center">

| Home | Fridge | AI meal plan | Weekly menu | Household agent |
|:---:|:---:|:---:|:---:|:---:|
| 8 entry tiles<br>expiry highlight + badge | chilled / frozen zones<br>swipe to edit or delete | streaming recipes<br>from stock | week view, 3 meals<br>shortage list + check-in | one sentence to<br>query, plan, compute |

</div>

## ✨ Features

### 🧊 Inventory
- **Photo-based intake**: up to 9 images per batch, sequential vision-model recognition → human review → bulk insert
- **Shelf-life estimation and expiry reminders** via WeChat subscription messages
- **Chilled / frozen zones** with swipe-to-edit, swipe-to-delete
- **Real-time sync for two**: all business data is shared per `space_id`

### 🍳 AI Meal Planning
- Generates recipes **from what's actually in your fridge**, streamed token-by-token over SSE
- Each dish carries quantities, cooking steps and a nutrition estimate (kcal / protein / carb / fat)
- You pick how many dishes to generate; the prompt constrains the model to the ingredients in your fridge (basic seasonings aside)

### 🧠 Multi-turn Memory
- The agent carries the **last 5 turns** of conversation, so follow-ups like "plan it like you said" or "what about the second one" resolve correctly
- Without history, multi-turn conversation simply doesn't connect — this layer is deliberate

### 📅 Four-Table Closed Loop
Inventory ↔ recipes ↔ weekly plan ↔ shopping list are genuinely linked:
```
Plan the week → compute shortages (demand − stock) → add to cart → buy and stock in
             → mark "cooked" → idempotent stock deduction + consumption log → feed next week
```

### 💬 Household Agent (ReAct)
One sentence triggers a multi-step tool chain. **12 tools** orchestrated server-side:

```
User:  What should we cook this week?

Agent: [1] query_inventory  ✓ 0.2s   → 23 ingredients found
       [2] get_shortage     ✓ 0.4s   → 3 items missing
       [3] add_plan_item    ✓ 0.6s   → added to Wednesday dinner
       → "Planned 5 dishes for the week. Still need tomatoes, eggs and scallions — add to cart?"
```

### 🍽️ Dish Requests & Recipes
- **4-state request machine**: `wanted → accepted → done / cancelled` — your partner can accept your request
- Three-tier ingredient matching (enough / not enough / missing)
- Recipe favorites and a **full-screen cooking mode** (large type, step timer, screen kept awake)

### 📊 Nutrition Tracking
- Today's ring chart, macro progress bars, 7-day trend, and a one-line summary
- Daily goals are fixed at 2000 kcal / 60g protein / 250g carb / 65g fat (see `GOALS` in `utils/nutrition.js`)
- Nutrition flows from recipe to consumption log without double-counting
- Meals **without** a nutrition estimate are called out explicitly: reporting only the total would imply it's your whole intake when the missing meals may be most of it

### 🔔 Notifications
- Two independent subscription-message pipelines (expiry, dish request) on a 5-minute cron
- In-app notices as a fallback, so nothing is lost when the user declines

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  WeChat Mini Program (native)                │
│  23 pages  ·  31 utils modules  ·  SSE streaming render      │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS
                           ▼
┌─────────────────────────────────────────────────────────────┐
│               server/cloud-gateway.js  (:8787)               │
│  One process, three path prefixes, one public port           │
│  ├─ /.cloud/auth/v1/*       → WeChat code2session, HS256 JWT │
│  ├─ /.cloud/database/rest/* → prefix-stripped to PostgREST   │
│  └─ /llm/*                  → reverse proxy to :8788         │
└──────────┬───────────────────────────────┬──────────────────┘
           │                               │
           ▼                               ▼
┌────────────────────┐        ┌──────────────────────────────┐
│  PostgREST :3000   │        │ server/llm-proxy.js  (:8788) │
│  RLS enforced      │        │ 4 task handlers + Agent loop │
└─────────┬──────────┘        │ SSE relay / HMAC / rate limit│
          │                   └──────────────┬───────────────┘
          ▼                                  ▼
┌────────────────────┐        ┌──────────────────────────────┐
│  PostgreSQL 16     │        │  NewAPI (OpenAI-compatible)  │
│  12 tables         │        │  → multiple upstream models  │
│  42 RPCs, 19 RLS   │        └──────────────────────────────┘
└────────────────────┘
```

**Key design decisions**:

- **Single-port gateway** — WeChat allows only one whitelisted request domain per Mini Program, so auth, data and AI share one process and one port, routed by path prefix.
- **JWT straight into PostgREST** — the `access_token` issued at login *is* a PostgREST JWT (`{sub: 'wx:<openid>', role: 'authenticated'}`). No translation layer; `auth.uid()` just works.
- **Every sensitive table behind `SECURITY DEFINER`** — three tables (cart, dish requests, reminder queue) revoke all table grants and are reachable only through functions that verify household membership.

## 🚀 Getting Started

### Prerequisites

| Dependency | Version | Notes |
|---|---|---|
| [WeChat DevTools](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html) | Stable | Base library 3.17.5+ |
| Node.js | >= 18 | Server has zero third-party dependencies |
| PostgreSQL | 16 | Or use Docker |
| Docker + Compose | optional | One-command pg + postgrest + gateway |

### 1. Frontend (Mini Program)

```bash
git clone https://github.com/cjm-m/wechat-pantry-ai.git
cd wechat-pantry-ai
```

**Create your private config** (domain, AppID and template IDs never enter the repo):

```bash
cp utils/local-config.example.js utils/local-config.js
```

Edit `utils/local-config.js` with your own values:

```js
module.exports = {
    CLOUD_ENDPOINT: 'https://your-domain.example.com',   // your self-hosted gateway
    CLOUD_PUBLISHABLE_KEY: 'wbpk_xxxx...',               // must match the server env var
    LLM_SERVER_BASE: 'https://your-domain.example.com',  // usually the same
    SUBSCRIBE_TEMPLATES: { expire: '', dish: '' },        // empty = no pushes, everything else works
};
```

Open the repo root in WeChat DevTools, change `appid` in `project.config.json` to yours, then run **Build npm** (a missing `miniprogram_npm` causes a white screen across the whole app).

> 💡 No backend yet? Set `PROVIDER` to `'platform'` in `utils/model-config.js` to explore the UI through the SDK's built-in channel.

### 2. Backend (self-hosted)

```bash
# 1. Start three containers (pg / postgrest / gateway)
cd ops
docker compose --env-file .env up -d

# 2. Create the schema (idempotent)
docker exec -i pg psql -U postgres -d postgres < draft/schema-rebuild.sql

# 3. Smoke test (behavioural assertions, rolled back inside a transaction)
docker exec -i pg psql -U postgres -d postgres < ddl-smoke-test.sql

# 4. Health probe — expect ALL_PASS
node deploy/gw-probe.js
```

The six idempotent scripts live in [`ops/deploy/`](ops/deploy/), each with a header comment covering what it does and how to roll back; see [`ops/README.md`](ops/README.md) for the entry point.

### 3. Environment Variables

Server-side only — **keep them on the server with mode 600, never in the repo**:

| Variable | Purpose |
|---|---|
| `CLOUD_JWT_SECRET` | Sign and verify business JWTs |
| `CLOUD_PUBLISHABLE_KEY` | The client's `x-wb-webapp-access-key`; must match `utils/local-config.js` |
| `PG_AUTH_PASS` | PostgREST database password |
| `NEWAPI_BASE` / `NEWAPI_KEY` / `NEWAPI_MODELS` | Upstream AI gateway |
| `LLM_TOKEN_SECRET` | HMAC token for AI endpoints |
| `WX_APPID` / `WX_SECRET` | WeChat login and subscription messages |
| `WX_TEMPLATE_EXPIRE` / `WX_TEMPLATE_DISH` | Subscription template IDs |

## 🧠 Engineering Highlights

| Highlight | Detail |
|---|---|
| **Streaming recipes over SSE** | ~1.5s to first token instead of waiting for the whole JSON. An incremental UTF-8 decoder prevents Chinese characters being split across chunks |
| **Layered timeout budget** | 58s upstream / 60s client — the extra 2s lets the server's error arrive before the client reports a timeout |
| **Agent tool orchestration** | 12 tools, each mapping to an existing RPC. Server-side ReAct loop capped at 6 rounds / 50s total; the tool layer only validates params and reshapes data |
| **Multi-turn memory** | The last 5 turns are carried so pronouns and follow-ups resolve; history stays in memory only, never persisted, so context can't grow unbounded |
| **Explainable ranking** | Every recommendation carries a one-line human reason ("uses the milk expiring in 2 days") instead of just a score |
| **Idempotent deduction** | Marking a meal as cooked runs a `SECURITY DEFINER` function; calling it twice does not deduct stock twice |
| **RLS + function-only access** | 12 tables with RLS enabled; 3 sensitive tables are RPC-only; `is_space_member()` avoids policy recursion |
| **Three AI channels** | `server` / `newapi` / `platform`, switched by one constant, all emitting identically shaped chunks |
| **Self-healing watchdog** | 8 checks (containers, pg, gateway, postgrest, llm, reminders, disk, memory); hard failures auto-restart, alerts require 2 consecutive rounds |
| **Contract-first prompts** | Prompts live server-side (the client sends structured params, never `messages`), so the public endpoint can't be abused as a general LLM proxy |
| **371 offline assertions** | 13 probe scripts covering meal plans, nutrition, dish requests, subscriptions, Agent flows and context recovery — run with `npm test` |

## 📁 Project Layout

```
├── pages/                    23 pages (home / fridge / cook / meal plan / agent / nutrition …)
├── utils/                    31 modules (data layer / AI adapters / auth guard / formatting)
│   ├── config.js             private-config loader
│   ├── local-config.example.js  ← copy to local-config.js and fill in real values
│   ├── cloud.js              single data-plane client
│   ├── llm.js                AI channel (SSE)
│   └── model-config.js       three-channel switch
├── components/               login panel (disabled) / swipe row
├── server/                   backend (excluded from the Mini Program bundle)
│   ├── cloud-gateway.js      public entry: auth + data + AI
│   ├── llm-proxy.js          4 AI tasks + Agent channel
│   ├── prompts.js            authoritative prompt copy
│   ├── reminder-cron.js      subscription message dispatcher (5-minute cron)
│   └── watchdog.js           health checks / self-healing / alerts
├── ops/                      operations (excluded from the bundle)
│   ├── deploy/               idempotent step1–6 scripts + probes
│   ├── draft/schema-rebuild.sql  2,658-line rebuildable DDL (12 tables / 42 business functions)
│   ├── ddl-smoke-test.sql    behavioural smoke assertions
│   ├── probes-offline.sh     npm test entry point
│   └── docker-compose.yml
└── cloudfunctions/cook/      fallback cloud function channel (currently dormant)
```

## 🗺️ Roadmap

- [x] Inventory (photo intake / shelf life / two-person sync)
- [x] AI meal planning (SSE streaming / nutrition estimates)
- [x] Dish-request state machine + recipe favorites
- [x] Household agent (12-tool ReAct)
- [x] Four-table closed loop (weekly plan / shortages / idempotent deduction / consumption log)
- [x] Full-screen cooking mode
- [x] Nutrition tracking
- [x] Self-hosted backend (Postgres + PostgREST + gateway)
- [x] Subscription messages (expiry / dish requests)
- [ ] Recipe import from URL or shared text
- [ ] Voice-based meal logging

## 🤝 Contributing

Issues and pull requests are welcome. Before you start, it helps to read [`ops/README.md`](ops/README.md) and the header comments in each module — the code is heavily commented, and almost every non-obvious decision explains *why* inline, which beats any separate doc.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/); Chinese subjects are fine (that's how this repo was built).

## 📄 License

[MIT](LICENSE) © 2026 cjm

---

<div align="center">

**If this little project helps you, a ⭐️ would be lovely**

</div>
