#!/usr/bin/env bash
#
# 发布门禁链：按顺序跑完整套门禁，任一步非 0 即停，并逐条打印退出码与耗时。
#
# 为什么需要它：`npm run verify` 只覆盖「类型 + lint + 单测 + 集成 + 构建 + e2e」，
# 不含 `test:e2e:electron`、`audit`、`dist`、`verify:package`。
# 发布验收必须跑全，不能只跑 verify 就宣称全部门禁通过。
#
# 用法：bash tools/release-gate.sh
#   - 日志写屏并写入本次独立的 <GATE_LOG_DIR>/a4-gate-<构建ID>.txt（不固定覆盖
#     上次证据）。GATE_LOG_DIR 可注入（测试用每场景独立临时目录做隔离），
#     默认 /tmp（S6：默认目录固定为 /tmp，归属明确；不再写入固定的 a4-gate.txt）
#   - dist 会自动带 electron 镜像（直连 GitHub 常 ETIMEDOUT）
#   - dist 与其他步骤走同一条 run 路径：非 0 立即停止，保留该退出码，
#     不执行 verify:package，不打印 ALL_GREEN
#   - S3：发布门禁最后一步改为 tools/verify-release.cjs，必须显式绑定本次构建
#     登记——GATE_CANDIDATE_DIR（候选目录）与 GATE_BUILD_ID（唯一构建 ID）两者
#     缺一即在构建前失败关闭（exit 2），不再回落 candidate-manifest.json 默认候选；
#     显式目标与登记不一致时 verify-release 失败关闭，不允许自动重登记掩盖。
#     旧候选身份核验（不构成发布验收）用 npm run verify:package。
#   - 退出码：0 全绿；否则等于第一个失败步骤的退出码（绑定缺失为 2）
set -u
export PATH="/usr/bin:/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1

GATE_ID="$(date +%Y%m%d-%H%M%S)-$$"
GATE_LOG_DIR="${GATE_LOG_DIR:-/tmp}"
LOG="${GATE_LOG_DIR}/a4-gate-${GATE_ID}.txt"
mkdir -p "$GATE_LOG_DIR" || exit 1
: > "$LOG"

# S3：绑定预检放在构建前——缺绑定的门禁连 dist 都不许跑，避免40分钟构建后才发现无效
if [ -z "${GATE_CANDIDATE_DIR:-}" ] || [ -z "${GATE_BUILD_ID:-}" ]; then
  echo "STOPPED at verify:package：缺少 GATE_CANDIDATE_DIR/GATE_BUILD_ID 显式绑定（发布门禁不回落默认候选）" | tee -a "$LOG"
  exit 2
fi
echo "BINDING candidate=$GATE_CANDIDATE_DIR buildId=$GATE_BUILD_ID" | tee -a "$LOG"

run() {
  local name="$1"; shift
  echo "=== $name ===" | tee -a "$LOG"
  local start
  start=$(date +%s)
  "$@" >> "$LOG" 2>&1
  local code=$?
  local secs=$(( $(date +%s) - start ))
  echo "EXIT $name = $code (${secs}s)" | tee -a "$LOG"
  if [ "$code" -ne 0 ]; then
    echo "STOPPED at $name" | tee -a "$LOG"
    exit "$code"
  fi
}

run typecheck     npm run typecheck
run lint          npm run lint
run test:unit     npm run test:unit
run test:integration npm run test:integration
run build         npm run build
run test:e2e      npm run test:e2e
run test:e2e:electron npm run test:e2e:electron
run audit         npm run audit

# dist 与其他步骤同一条 run 路径（修复：此前 dist 直接执行、仅 echo 退出码，
# 失败后仍会继续 verify 并可能对旧产物打印 ALL_GREEN）。
# 用 export 而非 env 前缀，保证 dist 步骤仍是可被桩替换的普通命令。
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
run dist npm run dist
unset ELECTRON_MIRROR ELECTRON_BUILDER_BINARIES_MIRROR

# 核对必须绑定本次构建登记（S3）：verify-release 校验 buildId/候选目录/来源提交
# 与 candidate-manifest.json（schema/2）一致、out/** 逐文件一致、zip 与候选同源，
# 任何不一致都失败关闭。旧候选身份核验（verify-package.cjs）不在这里使用。
run verify:package node tools/verify-release.cjs --candidate-dir "$GATE_CANDIDATE_DIR" --build-id "$GATE_BUILD_ID"

echo "ALL_GREEN" | tee -a "$LOG"
