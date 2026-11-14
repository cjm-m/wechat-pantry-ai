#!/usr/bin/env bash
# 跑「离线探针」——零网络、零依赖、任何机器上都能跑。
#
# 每个脚本都是纯函数 + 桩测试，末尾打印「通过 N 项，失败 0 项」。
# 任何一项失败都会以非 0 退出，可以直接接进 CI。
#
#   bash ops/probes-offline.sh      # 或 npm test
#
# 注意：ops/tmp-*.js 里还有一批**联网探针**，它们需要真实 llm-proxy 与
# LLM_TOKEN_SECRET 自签令牌，必须在服务器容器内跑。清单见 ops/README.md。

set -uo pipefail
cd "$(dirname "$0")/.."

PROBES=(
    ops/tmp-mealplan-e2e.js
    ops/tmp-nutrition-e2e.js
    ops/tmp-cook-mode-e2e.js
    ops/tmp-agent-e2e.js
    ops/tmp-context-recover-e2e.js
    ops/tmp-subscribe-fallback.js
    ops/tmp-cron-e2e.js
    ops/tmp-cron-dish-e2e.js
    ops/tmp-cron-dryrun.js
    ops/tmp-format-e2e.js
    ops/tmp-page-wiring.js
    ops/tmp-pick-test.js
    ops/tmp-buildgroups-test.js
)

total_pass=0
failed=()

for probe in "${PROBES[@]}"; do
    if [ ! -f "$probe" ]; then
        echo "⚠️  跳过（文件不存在）：$probe"
        continue
    fi
    echo "─────────  $(basename "$probe")  ─────────"
    if node "$probe"; then
        echo
    else
        echo
        failed+=("$(basename "$probe")")
    fi
done

echo "════════════════════════════════════════"
if [ ${#failed[@]} -eq 0 ]; then
    echo "全部离线探针通过 ✅"
    exit 0
fi

echo "失败的探针（${#failed[@]} 个）："
for name in "${failed[@]}"; do echo "  - $name"; done
exit 1
