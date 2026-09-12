#!/usr/bin/env bash
#
# 发布门禁链：按顺序跑完整套门禁，任一步非 0 即停，并逐条打印退出码与耗时。
#
# 为什么需要它：`npm run verify` 只覆盖「类型 + lint + 单测 + 集成 + 构建 + e2e」，
# 不含 `test:e2e:electron`、`audit`、`dist`、`verify:package`。
# 发布验收必须跑全，不能只跑 verify 就宣称全部门禁通过。
#
# 用法：bash tools/release-gate.sh
#   - 日志同时写屏与 /tmp/a4-gate.txt
#   - dist 会自动带 electron 镜像（直连 GitHub 常 ETIMEDOUT）
#   - 退出码：0 全绿；否则等于第一个失败步骤的退出码
set -u
export PATH="/usr/bin:/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1

LOG=/tmp/a4-gate.txt
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

echo "=== 构建候选包（带镜像）===" | tee -a "$LOG"
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
  npm run dist >> "$LOG" 2>&1
echo "EXIT dist = $?" | tee -a "$LOG"

run verify:package npm run verify:package
echo "ALL_GREEN" | tee -a "$LOG"
