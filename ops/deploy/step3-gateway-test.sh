#!/usr/bin/env bash
# 步骤 3：起 gateway 测试容器并自测（不动线上 llm-proxy）
set -euo pipefail

echo "== 安装文件 =="
install -m 644 -o root -g root /tmp/cloud-gateway.js /root/llm-proxy/cloud-gateway.js
install -m 644 -o root -g root /tmp/gateway-runner.js /root/llm-proxy/gateway-runner.js
install -m 644 -o root -g root /tmp/rollback-gateway.js /root/llm-proxy/rollback-gateway.js
ls -l /root/llm-proxy/

echo "== 起 gw-check =="
node /root/llm-proxy/gateway-runner.js test
sleep 2
docker ps --filter name=gw-check --format '{{.Names}}\t{{.Status}}'

echo "== gw-check 日志（前 20 行） =="
docker logs --tail 20 gw-check || true

echo "== 容器内自测 =="
docker cp /tmp/gw-probe.js gw-check:/tmp/gw-probe.js
docker exec gw-check node /tmp/gw-probe.js || echo "PROBE_FAILED"