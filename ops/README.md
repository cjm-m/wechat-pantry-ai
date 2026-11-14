# ops/ —— 运维与部署

这个目录**不会被打进小程序包**（见 `project.config.json` 的 `packOptions.ignore`），
只在服务器上执行，或者在本地做验证。

## 目录

| 路径 | 内容 |
|---|---|
| `deploy/step1–6*.sh` | 幂等的部署脚本，按编号顺序执行 |
| `deploy/gateway-runner.js` | 切换线上网关（`swap` 子命令） |
| `deploy/rollback-gateway.js` | 按切换前的 JSON 原样重建容器 |
| `deploy/*-probe.js` | 网关 / 限流 / 客户端 IP 探针 |
| `draft/schema-rebuild.sql` | 可重建的完整 DDL：2,658 行（12 表 / 42 个业务函数 / 19 条 RLS policy） |
| `ddl-smoke-test.sql` | 建表后的行为冒烟，事务内跑完 rollback |
| `docker-compose.yml` | pg + postgrest + llm-proxy 三容器 |
| `probes-offline.sh` | 离线探针批量入口（`npm test` 走这里） |

## 两类探针，别混

### 离线探针（任何机器都能跑）

纯函数 + 桩，零网络、零依赖。跑法：

```bash
npm test
# 或
bash ops/probes-offline.sh
```

当前 13 个脚本、371 项断言全过。每个脚本末尾都会打印「通过 N 项，失败 0 项」。

### 联网探针（必须在服务器上跑）

这些需要真实的 `llm-proxy` 与 `LLM_TOKEN_SECRET` 自签令牌，本地跑会直接报
`The "key" argument must be of type string ... Received undefined`：

```
tmp-e2e-catalog.js      模型目录与兜底优先级
tmp-recipe-sse.js       SSE 首块延迟 + 多变长 steps
tmp-recipe-steps.js     做法步骤条数与字数
tmp-recipe-trunc.js     多菜输出的 token 截断
tmp-sse-check.js        SSE 是否退化成一次性返回
tmp-text-probe.js       文本任务盲测（按用户最终看到的判定）
tmp-glm-recipe-dump.js  单个模型输出转储
tmp-vision-probe.js     识图能力盲测（随机指纹防幻觉）
tmp-vision-as-text.js   视觉模型能否承担文本任务
tmp-vision-quality.js   3 张真实照片的识图质量
```

跑法（在 llm-proxy 容器内）：

```bash
docker exec -e LLM_TOKEN_SECRET="$(grep ^LLM_TOKEN_SECRET /root/cloud-secrets.env | cut -d= -f2-)" \
    llm-proxy node /path/to/tmp-recipe-sse.js
```

## 部署顺序

```
step1-database.sh   → step2-postgrest.sh → step3-gateway-test.sh（一次性自测）
                    → gateway-runner.js swap（切换线上）
                    → step4-reminder-cron.sh → step5-compose.sh → step6-watchdog.sh
```

step6 因宿主 root shell 是 zsh，需要这样喂进去：

```bash
ssh my-server 'bash -s' < step6-watchdog.sh
```

step4 需要对外域名作为参数（脚本里不再写死）：

```bash
PUBLIC_BASE=https://your-domain.example.com bash step4-reminder-cron.sh
```

## 几个必读的坑

- 改 env 必须 `docker rm -f` 重建容器（`--env-file` 只在 create 时读）；改 `prompts.js` 只需 `docker restart`。
- 三个容器都不发布宿主端口，对外唯一入口是反向代理。
- `schema-rebuild.sql` 里 3 张函数表必须显式 `REVOKE`，否则平台默认 ACL 会给新表授权。
- 策略里直接子查询 `couple_member` 会触发 `42P17` 递归，必须走 `is_space_member()`。

每个脚本开头的注释都写了它做什么、以及失败时怎么回滚。
