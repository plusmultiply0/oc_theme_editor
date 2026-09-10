/**
 * 目标 adapter 契约（T31）。
 *
 * adapter 只「声明」目标是什么、资源在哪、允许改哪些条目；
 * 不负责扫描磁盘，也不接受用户拼接的任意路径。
 * 绝不允许因为「文件叫 app.asar」就认定兼容。
 */

/** 资源布局：相对安装根目录的固定相对路径 */
export interface ResourceLayout {
  /** 可执行文件，用于进程检测与版本比对 */
  exe: string;
  /** 应用归档 */
  archive: string;
}

/** 注入点：只改这几个归档内条目，其他一律保持原样 */
export interface AdapterInjection {
  /** 归档内 HTML 入口 */
  htmlEntry: string;
  /** 注入的自定义样式文件（会新增） */
  cssFile: string;
  /** 注入的背景图片文件（会新增） */
  imageFile: string;
  /** HTML 中用于插入 link 标签的锚点，找不到就拒绝，不做猜测 */
  anchor: string;
}

export interface TargetAdapter {
  id: string;
  /** 发行渠道，例如 windows-local-user-install */
  channel: string;
  /** 运行框架；不是 electron-asar 就不能套用归档补丁方案 */
  framework: 'electron-asar';
  /** 安装目录下的目录名候选，用于「明确候选位置」扫描 */
  installDirNames: readonly string[];
  /** 归档 package.json 的 name，用于区分同名分发版 */
  packageName: string;
  /** 已验证版本白名单；不在名单内一律 unknown，只允许预览 */
  supportedVersions: readonly string[];
  layout: ResourceLayout;
  injection: AdapterInjection;
  /** 归档内允许被本工具新增/修改的条目白名单（T35） */
  allowedChanges: readonly string[];
  /** 依据归档 package.json 判断是否为该 adapter 的目标 */
  matches(pkg: { name?: string; version?: string }): boolean;
}

export function adapterMatchesVersion(adapter: TargetAdapter, version: string): boolean {
  return adapter.supportedVersions.includes(version);
}
