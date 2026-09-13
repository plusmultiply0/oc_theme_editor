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
#   - 设置 GATE_CANDIDATE_DIR 可让 verify:package 核对指定候选目录；
#     未设置时沿用 npm run verify:package 的默认目标（由候选配置决定）
#   - 退出码：0 全绿；否则等于第一个失败步骤的退出码
set -u
export PATH="/usr/bin:/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1

GATE_ID="$(date +%Y%m%d-%H%M%S)-$$"
GATE_LOG_DIR="${GATE_LOG_DIR:-/tmp}"
LOG="${GATE_LOG_DIR}/a4-gate-${GATE_ID}.txt"
mkdir -p "$GATE_LOG_DIR" || exit 1
: > "$LOG"

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

# 核对必须绑定本次候选：发布链上应通过 GATE_CANDIDATE_DIR 显式指定候选目录，
# 防止核对到「某个仍然存在的旧目录」。
if [ -n "${GATE_CANDIDATE_DIR:-}" ]; then
  run verify:package node tools/verify-package.cjs "$GATE_CANDIDATE_DIR"
else
  run verify:package npm run verify:package
fi

echo "ALL_GREEN" | tee -a "$LOG"
