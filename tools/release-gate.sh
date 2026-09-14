#!/usr/bin/env bash
#
# 发布门禁薄入口（P3）：委托 tools/release-build.cjs 执行统一发布链。
#
# 为什么保留这层：历史上门禁是本文件里一条 shell 链，构建/打包会跑两次、
# 且 dist 输出与核验目标可能不是同一个目录。P3 把顺序与唯一性收敛到
# tools/release-build.cjs（build / verify 两种模式），本脚本只做两件事：
#   1. 保留既有的「缺绑定即失败关闭」预检语义（GATE_MANIFEST 等）；
#   2. 把参数透传给编排器，保持 `bash tools/release-gate.sh` 入口不变。
#
# 用法：
#   bash tools/release-gate.sh                 # 全链 build（buildId 自动生成）
#   bash tools/release-gate.sh build <buildId> # 指定 buildId
#   bash tools/release-gate.sh verify <buildId># 只读核验既有候选
#
# 环境变量（历史兼容）：
#   GATE_MANIFEST / GATE_CANDIDATE_DIR / GATE_BUILD_ID —— verify 模式下若给出，
#   用于校验与编排器推导的目标一致；build 模式下不使用（由编排器生成）。
#   GATE_LOG_DIR —— 日志目录（默认 /tmp），本脚本把整链输出 tee 到独立日志。
#
# 退出码：0 全绿；否则等于第一个失败步骤的退出码（绑定缺失为 2）。
set -u
export PATH="/usr/bin:/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1

MODE="${1:-build}"
BUILD_ID="${2:-${GATE_BUILD_ID:-}}"

if [ "$MODE" = "verify" ]; then
  # verify 模式：显式绑定校验——缺 manifest/candidate/buildId 即失败关闭
  if [ -z "${GATE_MANIFEST:-}" ] || [ -z "${GATE_CANDIDATE_DIR:-}" ] || [ -z "$BUILD_ID" ]; then
    echo "STOPPED at verify:package：verify 模式缺少 GATE_MANIFEST/GATE_CANDIDATE_DIR/GATE_BUILD_ID 显式绑定（不回落默认候选）"
    exit 2
  fi
fi

GATE_ID="$(date +%Y%m%d-%H%M%S)-$$"
GATE_LOG_DIR="${GATE_LOG_DIR:-/tmp}"
LOG="${GATE_LOG_DIR}/a4-gate-${GATE_ID}.txt"
mkdir -p "$GATE_LOG_DIR" || exit 1
: > "$LOG"

if [ -n "$BUILD_ID" ]; then
  echo "BINDING mode=$MODE buildId=$BUILD_ID" | tee -a "$LOG"
else
  echo "BINDING mode=$MODE buildId=(auto)" | tee -a "$LOG"
fi

# 整链输出同时写屏与写日志；退出码原样保留
if [ -n "$BUILD_ID" ]; then
  node tools/release-build.cjs "$MODE" "$BUILD_ID" 2>&1 | tee -a "$LOG"
else
  node tools/release-build.cjs "$MODE" 2>&1 | tee -a "$LOG"
fi
CODE="${PIPESTATUS[0]}"

if [ "$CODE" -ne 0 ]; then
  echo "STOPPED at release-$MODE" | tee -a "$LOG"
  exit "$CODE"
fi
# S2：结论标记只由编排器输出——ALL_GREEN=发布级终检通过；DEV_BUILD_COMPLETE=
# 不可发布的开发构建；CORE_VERIFY_GREEN=core 基础核验。薄入口只透传退出码，
# 不再把「子进程返回 0」升级为发布成功标记。
