/**
 * 补丁产物归属标记（structural-compat 计划 S1，判据单一来源）。
 *
 * 注入注释与 CSS 生成横幅在「写入」与「结构验证」两侧都要用到：
 * 写入侧（stage/css 生成）打标记，验证侧（compat-check）凭标记识别
 * 归档内已存在的 css/图片是否本工具产物。定义只允许存在这一份。
 */

/** 注入到 HTML 的注释标记，随 <link> 一起写入 */
export const HTML_INJECT_COMMENT = '<!-- opencode-theme-switcher -->';

/** 生成 CSS 首部注释里的归属短语 */
export const CSS_OWN_BANNER = '由 OpenCode 换肤助手生成';
