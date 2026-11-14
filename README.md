<div align="center">

# 🍚 我们的小家 · WeChat Pantry AI

**双人共享冰箱 · AI 配菜 · 家庭助手 Agent**

一个给两个人用的微信小程序：把冰箱里的食材记下来，让 AI 告诉你今晚能做什么。

[![WeChat MiniProgram](https://img.shields.io/badge/微信小程序-原生-07C160?logo=wechat&logoColor=white)](#)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](#)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

简体中文 | [English](README.en.md)

</div>

---

## 📖 项目简介

**我们的小家**是一个真实的、两人共用的家庭小工具。核心场景只有一句话：

> 冰箱里有什么？—— AI 用这些食材配几道菜 —— 缺什么就加进购物车 —— 做完扣库存、记消耗。

它不是又一个菜谱 App，而是一个**为「两个人一起过日子」设计的小系统**：两个人共享同一份冰箱库存，谁买了什么、谁点了什么菜、这周还剩几顿没做，都实时同步。

**能力一览**

- 🔍 **智能问答**：冰箱里有什么、什么快过期了、这周还缺什么，一句话问出来
- 🍽️ **临期优先推荐**：按「临期紧急度 + 库存覆盖率 + 菜式多样性」打分排序，先吃快坏的
- 🗓️ **一周饮食计划**：按周排早/午/晚三餐，自动算缺料，做完一键打卡扣库存
- 🧾 **AI 录入**：拍照识别 9 张图批量入库；也可以直接说「刚买了排骨两斤」记进冰箱
- 📊 **营养追踪**：今日环形图 + 三大营养素 + 近 7 天趋势，数据随菜谱自动流转
- 🧠 **多轮对话**：带最近 5 轮上下文，「就按你说的排」这类指代能接得住
- 💬 **随手闲聊**：不只管冰箱，问怎么做菜、聊两句都行，家庭这部分有工具能真的替你做

面向**两个人合租 / 同住**的场景：一个人买了菜另一个人能看见，谁点菜谁做菜有记录，不用再靠微信对账。

<div align="center">

| 首页 | 冰箱 | AI 配菜 | 这周吃什么 | 家庭助手 |
|:---:|:---:|:---:|:---:|:---:|
| 8 个功能入口<br>临期高亮 + 未读角标 | 冷藏/冷冻分区<br>左滑编辑删除 | 按库存流式出菜谱<br>逐字刷新 | 周视图三餐<br>缺料清单 + 打卡 | 一句话查冰箱<br>排菜单、算缺料 |

</div>

## ✨ 核心功能

### 🧊 食材管理
- **拍照识别入库**：一次最多 9 张图，串行调用视觉模型识别 → 人工核对 → 批量入库
- **保质期估算与临期提醒**：入库时自动估算，到期前推送订阅消息
- **冷藏 / 冷冻分区**：左滑编辑、删除、改数量
- **双人实时同步**：所有数据按 `space_id` 云端共享

### 🍳 AI 配菜
- 按「冰箱里现有的食材」出菜谱，**SSE 流式逐字输出**，不用干等
- 每道菜自带用量、做法步骤与营养估算（热量/蛋白/碳水/脂肪）
- 可以指定做几道菜；提示词里约束了「只用冰箱里的食材，基础调料除外」

### 🧠 多轮对话
- Agent 会带回**最近 5 轮**对话，可以接「就按你说的排」「那第二道呢」这类指代
- 不带历史的话多轮对话完全接不上，所以这一层是刻意做的

### 📅 四表联动闭环
库存 ↔ 菜谱 ↔ 周计划 ↔ 购物清单，四张表真的联动：
```
排周计划 → 自动算缺料（需求 - 库存）→ 勾选加入购物车 → 买菜入库
        → 「做完」打卡 → 幂等扣减库存 + 写消耗记录 → 反哺下周推荐
```

### 💬 家庭助手 Agent（ReAct）
一句话搞定多步操作，**12 个工具**在服务端编排：

```
用户：这周晚上吃什么好？

Agent：[1] 查冰箱 ✓ 0.2s      → 拿到 23 样食材
       [2] 算缺料 ✓ 0.4s      → 发现缺 3 样
       [3] 排一道菜 ✓ 0.6s    → 写入周三晚餐
       → 「这周给你排了 5 道菜，还缺番茄、鸡蛋、葱，要加进购物车吗？」
```

### 🍽️ 点菜与菜谱
- **4 态点菜状态机**：`wanted → accepted → done / cancelled`，TA 点的菜你能接单
- 缺料三档比对（够 / 不够 / 没有）
- 菜谱收藏、**全屏烹饪模式**（大字 + 步骤计时器 + 屏幕常亮）

### 📊 营养追踪
- 今日环形图 + 三大营养素进度条 + 近 7 天趋势 + 一句话总结
- 每日目标固定为 2000 千卡 / 蛋白 60g / 碳水 250g / 脂肪 65g（写在 `utils/nutrition.js` 的 `GOALS` 里）
- 数据从菜谱一路流转到消耗记录，不重复计算
- **缺估算的餐会被单独点名**：只报总量会让人误以为这就是全部摄入，而漏掉的那几餐可能占一大半

### 🔔 订阅消息
- 临期提醒、点菜提醒两条独立链路，5 分钟 cron 扫描
- 站内消息兜底，用户拒收也不丢失

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────────────┐
│                      微信小程序（原生）                        │
│  pages/ 23 个页面  ·  utils/ 31 个模块  ·  SSE 流式渲染        │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS
                           ▼
┌─────────────────────────────────────────────────────────────┐
│               server/cloud-gateway.js  (:8787)               │
│  一个进程，三套路径，对外只暴露一个端口                          │
│  ├─ /.cloud/auth/v1/*      → 微信 code2session，签 HS256 JWT  │
│  ├─ /.cloud/database/rest/* → 剥前缀透传给 PostgREST          │
│  └─ /llm/*                 → 反代同进程 8788 的 llm-proxy     │
└──────────┬───────────────────────────────┬──────────────────┘
           │                               │
           ▼                               ▼
┌────────────────────┐        ┌──────────────────────────────┐
│  PostgREST :3000   │        │ server/llm-proxy.js  (:8788) │
│  按 JWT 走 RLS     │        │ 4 类任务 + Agent 通道         │
└─────────┬──────────┘        │ SSE 透传 / HMAC 令牌 / 限流    │
          │                   └──────────────┬───────────────┘
          ▼                                  ▼
┌────────────────────┐        ┌──────────────────────────────┐
│  PostgreSQL 16     │        │  NewAPI（OpenAI 兼容网关）    │
│  12 张表 / 42 个 RPC│        │  → 上游多家模型              │
│  19 条 RLS policy  │        └──────────────────────────────┘
└────────────────────┘
```

**几个关键设计**：

- **网关单端口**：小程序只能配一个 request 合法域名，所以登录 / 数据 / AI 三条路径共用一个进程、一个端口，靠路径前缀分流。
- **JWT 直通 PostgREST**：登录签发的 `access_token` 本身就是 PostgREST 认的 JWT（`{sub: 'wx:<openid>', role: 'authenticated'}`），不需要翻译层，`auth.uid()` 直接可用。
- **数据面全部走 SECURITY DEFINER**：3 张敏感表（购物车、点菜、提醒队列）表级权限全部 REVOKE，只经函数访问，函数内部校验小家归属。

## 🚀 快速开始

### 前置要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html) | 稳定版 | 基础库 3.17.5+ |
| Node.js | >= 18 | 服务端零第三方依赖 |
| PostgreSQL | 16 | 或用 Docker |
| Docker + Compose | 可选 | 一键起 pg + postgrest + gateway |

### 一、前端（小程序）

```bash
git clone https://github.com/cjm-m/wechat-pantry-ai.git
cd wechat-pantry-ai
```

**配置本地私有值**（域名 / AppID / 模板 ID 不进仓库）：

```bash
cp utils/local-config.example.js utils/local-config.js
```

编辑 `utils/local-config.js`，填你自己的：

```js
module.exports = {
    CLOUD_ENDPOINT: 'https://your-domain.example.com',   // 自建后端入口
    CLOUD_PUBLISHABLE_KEY: 'wbpk_xxxx...',               // 与服务端环境变量一致
    LLM_SERVER_BASE: 'https://your-domain.example.com',  // 通常同上
    SUBSCRIBE_TEMPLATES: { expire: '', dish: '' },        // 留空则不推送，不影响其他功能
};
```

用微信开发者工具「导入项目」打开仓库根目录，把 `project.config.json` 的 `appid` 改成你自己的，然后**构建 npm**（缺 `miniprogram_npm` 会全站白屏）。

> 💡 还没搭后端？可以先把 `utils/model-config.js` 的 `PROVIDER` 改成 `'platform'`，用 SDK 内置通道跑通界面。

### 二、后端（自建服务器）

```bash
# 1. 起三个容器（pg / postgrest / gateway）
cd ops
docker compose --env-file .env up -d

# 2. 建表（幂等，可重复执行）
docker exec -i pg psql -U postgres -d postgres < draft/schema-rebuild.sql

# 3. 冒烟测试（36 项行为断言，事务内 rollback）
docker exec -i pg psql -U postgres -d postgres < ddl-smoke-test.sql

# 4. 探活
node deploy/gw-probe.js    # 期望输出 ALL_PASS
```

六个幂等脚本在 [`ops/deploy/`](ops/deploy/)，各自开头的注释写了它做什么与失败时怎么回滚；入口说明见 [`ops/README.md`](ops/README.md)。

### 三、环境变量

服务端需要这些变量（**只放在服务器上，权限 600，绝不入库**）：

| 变量 | 用途 |
|---|---|
| `CLOUD_JWT_SECRET` | 签发 / 校验业务 JWT |
| `CLOUD_PUBLISHABLE_KEY` | 客户端带来的 `x-wb-webapp-access-key`，须与 `utils/local-config.js` 一致 |
| `PG_AUTH_PASS` | PostgREST 连接数据库的密码 |
| `NEWAPI_BASE` / `NEWAPI_KEY` / `NEWAPI_MODELS` | AI 上游网关 |
| `LLM_TOKEN_SECRET` | AI 接口的 HMAC 令牌 |
| `WX_APPID` / `WX_SECRET` | 微信登录与订阅消息 |
| `WX_TEMPLATE_EXPIRE` / `WX_TEMPLATE_DISH` | 订阅消息模板 ID |

## 🧠 技术亮点

| 亮点 | 说明 |
|---|---|
| **SSE 流式配菜** | 首字延迟 1.5s 左右，不用等整段 JSON 才渲染。中文跨 chunk 用增量 UTF-8 解码器，不吃字 |
| **分层超时预算** | 服务端上游 58s / 客户端 60s，刻意留 2s 让服务端的错误信息先回来，而不是客户端先报 timeout |
| **Agent 工具编排** | 12 个工具全对应已有 RPC，服务端 ReAct 循环最多 6 轮、总预算 50s；工具层只做参数校验和形状整理 |
| **多轮对话记忆** | 带回最近 5 轮，指代（「就按你说的排」）能接住；历史只保留轮次不落库，避免上下文无限膨胀 |
| **可解释推荐** | 每条推荐附一句人话理由（「用掉快过期的牛奶，还剩 2 天」），而不是只给一个分数 |
| **幂等扣减** | 「做完」打卡走 `SECURITY DEFINER` 函数，重复调用不重复扣库存 |
| **RLS + 函数收口** | 12 张表全开 RLS，3 张敏感表纯 RPC-only；用 `is_space_member()` 避免策略递归 |
| **容灾三通道** | `server` / `newapi` / `platform` 三条 AI 链路，改一个常量切换，输出同形 chunk |
| **watchdog 自愈** | 8 项探活（容器/pg/gateway/postgrest/llm/提醒/磁盘/内存），硬故障自动拉起，连续 2 轮才告警 |
| **契约优先的提示词** | 提示词放服务端（客户端传结构化参数，不传 messages），公网端点不会变成通用 LLM 代理 |
| **371 项离线断言** | 13 个探针脚本，覆盖配菜 / 周计划 / 营养 / 点菜 / 订阅消息 / 上下文恢复 / Agent 工具链；`npm test` 一键跑 |

## 📁 目录结构

```
├── pages/                    23 个页面（首页 / 冰箱 / 配菜 / 周计划 / Agent / 营养 …）
├── utils/                    31 个模块（数据层 / AI 适配 / 登录守卫 / 格式化）
│   ├── config.js             本地私有配置加载器
│   ├── local-config.example.js  ← 复制成 local-config.js 填真实值
│   ├── cloud.js              数据面唯一实例
│   ├── llm.js                AI 通道（SSE）
│   └── model-config.js       三通道开关
├── components/               登录面板（已停用）/ 左滑行
├── server/                   后端（不进小程序包）
│   ├── cloud-gateway.js      对外总入口：登录 + 数据 + AI
│   ├── llm-proxy.js          4 类 AI 任务 + Agent 通道
│   ├── prompts.js            提示词权威副本
│   ├── reminder-cron.js      订阅消息下发（cron 每 5 分钟）
│   └── watchdog.js           探活 / 自愈 / 告警
├── ops/                      运维（不进小程序包）
│   ├── deploy/               step1–6 幂等部署脚本 + 探针
│   ├── draft/schema-rebuild.sql  2,658 行可重建 DDL（12 表 / 42 个业务函数）
│   ├── ddl-smoke-test.sql    36 项行为断言
│   └── docker-compose.yml
└── cloudfunctions/cook/      AI 备用云函数通道（当前 dormant）
```

## 🗺️ Roadmap

- [x] 食材管理（拍照识别 / 保质期 / 双人同步）
- [x] AI 配菜（SSE 流式 / 营养估算）
- [x] 点菜状态机 + 菜谱收藏
- [x] 家庭助手 Agent（12 工具 ReAct）
- [x] 四表联动闭环（周计划 / 缺料 / 幂等扣减 / 消耗记录）
- [x] 全屏烹饪模式
- [x] 营养追踪
- [x] 自建后端（Postgres + PostgREST + 网关）
- [x] 订阅消息（临期 / 点菜）
- [ ] 菜谱 URL / 分享文本导入
- [ ] 语音饮食记录

## 🤝 贡献

欢迎提 Issue 和 PR。开工前建议先读 [`ops/README.md`](ops/README.md)，以及各模块文件头部的注释——这个项目的注释密度比较高，几乎每个反直觉的实现旁边都写了「为什么」，比任何文档都准。

提交规范参考 [Conventional Commits](https://www.conventionalcommits.org/)，用中文写 subject 也可以（仓库现状就是这样）。

## 📄 开源协议

[MIT](LICENSE) © 2026 cjm

---

<div align="center">

**如果这个小项目对你有帮助，给个 ⭐️ 吧**

</div>
