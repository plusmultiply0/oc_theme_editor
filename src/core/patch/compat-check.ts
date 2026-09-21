/**
 * 结构验证（structural-compat 计划 S1）。
 *
 * 只回答一个问题：壁纸补丁的注入机制在这个归档上是否**结构适用**——全程只读快照，
 * 不写安装目录、不改白名单、不做任何降级猜测。
 *
 * 判据（与 PLAN 检查项一一对应，绝不猜锚点、绝不近似注入）：
 * 1. 锚点唯一：adapter.injection.anchor 在 htmlEntry 中恰好出现 1 次；
 *    0 次 = 结构已变，≥2 次 = 无法唯一注入——一律不通过（与 probe 旧口径不同：
 *    旧工具层把多处标 WARN 交人工，核心判据按 PLAN 收紧为拒绝）；
 *    htmlEntry 读不到按「0 次」处理——注入落点不存在。
 * 2. 变更集合干净：cssFile/imageFile 不存在，或可识别为本工具产物
 *    （HTML 带注入标记 + CSS 带生成横幅）；无法确认归属即视为第三方占用，不通过。
 *    图片与 CSS 由工具成对写出，只有图片没有 CSS 无法自证归属，按占用处理。
 * 3. unpacked 完整性：信息项，只提示（WARN），不阻断。
 *
 * 单一来源约束：产品链路（inspectRoot）与 tools/version-probe 都消费本模块；
 * 判据只允许存在这一份，工具侧不得再抄一份独立实现。
 */
import fs from 'node:fs';
import type { TargetAdapter } from '../../adapters/types';
import { listAsarFiles, readAsarText, type AsarSnapshot } from './asar';
import { CSS_OWN_BANNER, HTML_INJECT_COMMENT } from './markers';

export type CompatStatus = 'PASS' | 'WARN' | 'FAIL';

export interface CompatCheck {
  key: 'anchor' | 'changeSet' | 'unpacked';
  name: string;
  status: CompatStatus;
  basis: string;
  detail: string;
}

export interface CompatReport {
  /** 无 FAIL 项即结构适用；WARN 是信息项，不阻断 */
  compatible: boolean;
  checks: CompatCheck[];
  failedNames: string[];
}

export interface VerifyStructureOptions {
  /** 磁盘探测注入缝（unpacked 目录检查）；归档读取始终走 snapshot。用最小签名而非 Pick<typeof fs>，真实 fs 可直接传入 */
  fs?: {
    existsSync: (path: string) => boolean;
    statSync: (path: string) => { isDirectory: () => boolean };
  };
}

export async function verifyStructure(
  snapshot: AsarSnapshot,
  adapter: TargetAdapter,
  opts: VerifyStructureOptions = {},
): Promise<CompatReport> {
  const fss = opts.fs ?? fs;
  const checks: CompatCheck[] = [];

  // 1) 锚点唯一（隐含 htmlEntry 存在性：条目读不到即结构已变）
  const basis = `统计「${adapter.injection.anchor}」在 ${adapter.injection.htmlEntry} 中出现次数`;
  const tr = await readAsarText(snapshot, adapter.injection.htmlEntry);
  let html: string | null = null;
  if (!tr.success) {
    checks.push({
      key: 'anchor',
      name: '注入锚点',
      status: 'FAIL',
      basis,
      detail: 'HTML 入口不存在或读不到：注入落点无从谈起',
    });
  } else {
    html = tr.data;
    const n = html.split(adapter.injection.anchor).length - 1;
    checks.push({
      key: 'anchor',
      name: '注入锚点',
      status: n === 1 ? 'PASS' : 'FAIL',
      basis,
      detail:
        n === 1
          ? '恰好 1 次，注入位置唯一'
          : n === 0
            ? '0 次：HTML 结构已变，现行注入方案不适用'
            : `${n} 次：注入位置不唯一，无法确定落点（不猜测）`,
    });
  }

  // 2) 变更集合干净：不存在，或可识别为本工具产物
  const files = listAsarFiles(snapshot.header);
  const cssFile = adapter.injection.cssFile;
  const imageFile = adapter.injection.imageFile;
  const present = [cssFile, imageFile].filter((f) => files.includes(f));
  let cssOurs = false;
  if (files.includes(cssFile)) {
    const cr = await readAsarText(snapshot, cssFile);
    cssOurs = cr.success && cr.data.includes(CSS_OWN_BANNER) && (html ?? '').includes(HTML_INJECT_COMMENT);
  }
  const offenders: string[] = [];
  if (files.includes(cssFile) && !cssOurs) offenders.push(cssFile);
  if (files.includes(imageFile) && !cssOurs) offenders.push(imageFile);
  checks.push({
    key: 'changeSet',
    name: '变更集合归属',
    status: offenders.length === 0 ? 'PASS' : 'FAIL',
    basis: 'listAsarFiles 查 cssFile/imageFile + 注入标记与生成横幅识别归属',
    detail:
      offenders.length === 0
        ? present.length === 0
          ? `两文件均不存在（干净）；归档共 ${files.length} 条目`
          : '已存在且可识别为本工具产物（HTML 注入标记与 CSS 生成标记齐全），再次应用将覆盖'
        : `已存在且无法确认归属，按第三方占用处理：${offenders.join('、')}——先走恢复流程再评估`,
  });

  // 3) unpacked 完整性（信息项，不阻断）
  const unpackedDir = `${snapshot.archivePath}.unpacked`;
  let unpackedOk = false;
  try {
    unpackedOk = fss.existsSync(unpackedDir) && fss.statSync(unpackedDir).isDirectory();
  } catch {
    unpackedOk = false;
  }
  checks.push({
    key: 'unpacked',
    name: 'unpacked 完整性（信息项）',
    status: unpackedOk ? 'PASS' : 'WARN',
    basis: 'resources/app.asar.unpacked 目录存在性',
    detail: unpackedOk
      ? '目录在位（原生模块是否完好仍需真机启动确认）'
      : '不存在（本工具未挂过主题时属正常）',
  });

  const failedNames = checks.filter((c) => c.status === 'FAIL').map((c) => c.name);
  return { compatible: failedNames.length === 0, checks, failedNames };
}

/** 供 rejectReason 组装：各 FAIL 项「名称——细节」 */
export function describeFailed(report: CompatReport): string {
  return report.checks
    .filter((c) => c.status === 'FAIL')
    .map((c) => `${c.name}——${c.detail}`)
    .join('；');
}
