#!/usr/bin/env bash
#
# 发布门禁薄入口（P3）：委托 tools/release-build.cjs 执行统一发布链。
#
# 为什么保留这层：历史上门禁是本文件里一条 shell 链，构建/打包会跑两次、
# 且 dist 输出与核验目标可能不是同一个目录。P3 把顺序与唯一性收敛到
# tools/release-build.cjs（build / verify 两种模式），本脚本只做三件事：
#   1. 保留既有的「缺绑定即失败关闭」预检语义（GATE_MANIFEST 等）；
#   2. 把**显式绑定与剩余参数**真正交给 Node 层（N4：不再静默丢弃）；
#   3. 把参数透传给编排器，保持 `bash tools/release-gate.sh` 入口不变。
#
# 用法：
#   bash tools/release-gate.sh                 # 全链 build（buildId 自动生成）
#   bash tools/release-gate.sh build <buildId> # 指定 buildId
#   bash tools/release-gate.sh verify <buildId># 只读核验既有候选
#   bash tools/release-gate.sh build <buildId> --strict   # 额外参数透传
#
# 环境变量（历史兼容）：
#   GATE_MANIFEST / GATE_CANDIDATE_DIR / GATE_BUILD_ID —— verify 模式下若给出，
#   用于校验与编排器推导的目标一致；build 模式下不使用（由编排器生成）。
#   N4：verify 模式下这两个路径变量**必须与 buildId 推导的目标一致**，否则
#   在运行核验前非零退出（2）。只传 buildId 时由编排器推导，保持原行为。
#   GATE_LOG_DIR —— 日志目录（默认 /tmp），本脚本把整链输出 tee 到独立日志。
#   OTS_NODE_BIN —— 编排器解释器（**仅供测试**注入桩，生产不设置；默认 node）。
#
# 退出码：0 全绿；否则等于第一个失败步骤的退出码（绑定缺失/不一致为 2）。
set -u
export PATH="/usr/bin:/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1

MODE="${1:-build}"
shift 2>/dev/null || true
BUILD_ID="${1:-${GATE_BUILD_ID:-}}"
if [ -n "${1:-}" ] && [ "${1#--}" = "$1" ]; then
  # 第二个位置参数是 buildId（不是 --开头的选项）
  shift
fi

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

# N4：把声明的路径绑定（仅 verify 模式有意义）与剩余参数一起交给 Node 层。
# 以前这两条路径只被判断非空，随后丢弃：变量指向 A、buildId 指向 B 时，
# 下层仍只核验 B 的推导路径。现在由 release-build.cjs 严格比较并在不一致时退出 2。
ARGS=("$MODE")
if [ -n "$BUILD_ID" ]; then
  ARGS+=("$BUILD_ID")
fi
if [ "$MODE" = "verify" ]; then
  ARGS+=("--manifest" "$GATE_MANIFEST" "--candidate-dir" "$GATE_CANDIDATE_DIR")
fi
# 剩余参数原样透传；未知参数由 Node 层报错（不在这里猜）
for extra in "$@"; do
  ARGS+=("$extra")
done

# 编排器的解释器：默认用 PATH 里的 node；OTS_NODE_BIN 可覆盖（**仅供测试**
# 注入桩以断言「绑定与参数是否真的传到了下一层」，生产环境不设置）。
NODE_BIN="${OTS_NODE_BIN:-node}"

# 整链输出同时写屏与写日志；退出码原样保留
"$NODE_BIN" tools/release-build.cjs "${ARGS[@]}" 2>&1 | tee -a "$LOG"
CODE="${PIPESTATUS[0]}"

if [ "$CODE" -ne 0 ]; then
  echo "STOPPED at release-$MODE" | tee -a "$LOG"
  exit "$CODE"
fi
# S2：结论标记只由编排器输出——ALL_GREEN=发布级终检通过；DEV_BUILD_COMPLETE=
# 不可发布的开发构建；CORE_VERIFY_GREEN=core 基础核验。薄入口只透传退出码，
# 不再把「子进程返回 0」升级为发布成功标记。
