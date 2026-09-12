/**
 * 真实安装写入结果的只读核验（事故验收用）。
 *
 * 只读取证，不改写任何文件。断言的都是「写入是否真的正确」：
 * - 归档整体哈希与条目数；
 * - HTML 里本工具链接**恰好一个**、标记唯一；
 * - CSS 是否用 html:root（F1）、stronger 是否随面板透明度（F2）、外壳限定规则（F2）；
 * - 背景图片字节数与哈希是否等于期望值；
 * - 可选：逐条完整性 + 非白名单脚本解析（慢，--deep 开启）。
 *
 * 用法：
 *   node tools/verify-real-install.cjs --archive <app.asar> [--expect-image-sha256 <hex>] [--deep]
 *
 * 退出码：0 全部通过；1 有失败项。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const OUT = path.join(__dirname, '..', 'out', 'core', 'patch', 'archive-verify.js');
if (!fs.existsSync(OUT)) {
  console.error('未找到 out/core/patch/archive-verify.js，请先 npm run build');
  process.exit(1);
}
const { scanArchive, verifyIntegrity, findSharedOffsetConflicts, checkScripts } = require(OUT);
const PROBE = path.join(__dirname, '..', 'out', 'core', 'theme', 'image-probe.js');
if (!fs.existsSync(PROBE)) {
  console.error('未找到 out/core/theme/image-probe.js，请先 npm run build');
  process.exit(1);
}
const { probeImageBytes, isMultiFrame } = require(PROBE);
const { OPENCODE_DESKTOP_ADAPTER } = require(path.join(__dirname, '..', 'out', 'adapters', 'opencode-desktop.js'));

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const has = (name) => argv.includes(`--${name}`);

const archive = flag('archive');
if (!archive) {
  console.error('缺少 --archive <app.asar>');
  process.exit(1);
}
const expectImage = flag('expect-image-sha256');
const expectFormat = flag('expect-image-format');
const expectSize = flag('expect-image-size');
const deep = has('deep');

const checks = [];
const add = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const full = sha256(fs.readFileSync(archive));
console.log(`归档：${archive}`);
console.log(`  SHA256 ${full}`);

const scan = scanArchive(archive);
if (!scan.success) {
  console.error(`scanArchive 失败：${scan.error.message}`);
  process.exit(1);
}
const entries = scan.data.entries;
add('归档头部可解析', true, `${entries.size} 条目`);

function readEntry(rel) {
  const e = entries.get(rel);
  if (!e) return null;
  const b = Buffer.alloc(e.size);
  const fd = fs.openSync(archive, 'r');
  try {
    fs.readSync(fd, b, 0, e.size, scan.data.dataStart + Number(e.offset));
  } finally {
    fs.closeSync(fd);
  }
  return b;
}

// ---------- HTML 结构 ----------
const htmlEntry = OPENCODE_DESKTOP_ADAPTER.injection.htmlEntry;
const htmlBuf = readEntry(htmlEntry);
add('HTML 条目存在', Boolean(htmlBuf), htmlEntry);
const html = htmlBuf ? htmlBuf.toString('utf8') : '';
const links = html.match(/<link[^>]*oc-theme-custom\.css[^>]*>/g) ?? [];
const markers = html.match(/opencode-theme-switcher/g) ?? [];
add('本工具链接恰好一个', links.length === 1, `${links.length} 个`);
add('工具标记唯一', markers.length === 1, `${markers.length} 个`);
add(
  '链接位于 head 内',
  html.indexOf(links[0] ?? '') >= 0 && html.indexOf(links[0] ?? '') < html.indexOf('</head>'),
);

// ---------- CSS 内容（F1 / F2） ----------
const cssBuf = readEntry(OPENCODE_DESKTOP_ADAPTER.injection.cssFile);
add('CSS 条目存在', Boolean(cssBuf));
const css = cssBuf ? cssBuf.toString('utf8') : '';
add('token 声明用 html:root（F1）', /html:root\s*\{/.test(css));
add('不再使用普通 :root 声明 token（F1）', !/(^|\n)\s*:root\s*\{/.test(css));
add('--background-stronger 随面板透明度（F2）', /--background-stronger:\s*rgba\(/.test(css));
add('外壳限定规则存在（F2）', css.includes('.bg-v2-background-bg-deep.flex-1'));

// ---------- 可选：逐条完整性 ----------
(async () => {
  // ---------- 背景图片（需要真实解码，因此放在 async 块内） ----------
  // ---------- 背景图片 ----------
  /*
   * A3：把「文件头识别」与「完整解码」分成两个独立检查项。
   * 旧实现只有一条「图片可解码（JPEG/PNG 魔数）」，实际只看了首字节 ——
   * 只剩头部的残图也能拿到 OK，名不副实。
   * 资源条目的扩展名不能用来推断格式：适配器固定写 .jpg，内容可能是 PNG/WebP。
   */
  const imageEntry = OPENCODE_DESKTOP_ADAPTER.injection.imageFile;
  const imgBuf = readEntry(imageEntry);
  add('背景图片条目存在', Boolean(imgBuf), imgBuf ? `${imgBuf.length} 字节（条目 ${imageEntry}）` : '');
  if (imgBuf) {
    const got = sha256(imgBuf);
    console.log(`  图片 SHA256 ${got}`);
    if (expectImage) add('图片哈希等于期望值', got === expectImage, `实际 ${got.slice(0, 16)}…`);

    const probed = await probeImageBytes(imgBuf);
    add(
      '文件头可识别',
      Boolean(probed.success && probed.data.headerFormat) ||
        Boolean(!probed.success && /SVG/.test(probed.error.message)),
      probed.success ? `headerFormat=${probed.data.headerFormat ?? 'null'}` : probed.error.message,
    );
    add(
      '完整解码成功',
      probed.success && probed.data.decoded === true,
      probed.success
        ? `${probed.data.format} ${probed.data.width}×${probed.data.height}`
        : `${probed.error.code}：${probed.error.message}`,
    );
    if (probed.success) {
      console.log(`  实际格式 ${probed.data.format}（条目名后缀不代表内容）`);
      add('不是多帧动图', !isMultiFrame(probed.data), `pages=${probed.data.pages ?? 1}`);
      if (expectFormat) {
        add('实际格式等于期望值', probed.data.format === expectFormat, `实际 ${probed.data.format}`);
      }
      if (expectSize) {
        const actual = `${probed.data.width}x${probed.data.height}`;
        add('尺寸等于期望值', actual === expectSize, `实际 ${actual}`);
      }
    }
  }


  if (deep) {
    const integrity = await verifyIntegrity(scan.data);
    add('逐条完整性', integrity.success, integrity.success ? `检查 ${integrity.data.checked} 条` : `${integrity.error.message} | ${integrity.error.detail ?? ''}`);
    const shared = findSharedOffsetConflicts(scan.data);
    add('共享 offset 一致性', shared.success, shared.success ? '无冲突' : shared.error.detail ?? shared.error.message);
    const isAllowed = (e) => OPENCODE_DESKTOP_ADAPTER.allowedChanges.includes(e);
    const scripts = await checkScripts(scan.data, { isAllowed });
    add(
      '非白名单脚本解析',
      scripts.success,
      scripts.success
        ? `解析成功 ${scripts.data.checked}；跳过 ${scripts.data.skipped}、不支持 ${scripts.data.unsupported}（这两类**未验证**，不计入成功）`
        : `${scripts.error.message} | ${scripts.error.detail ?? ''}`,
    );
  }

  let failed = 0;
  for (const c of checks) {
    console.log(`  ${c.ok ? '[OK]  ' : '[FAIL]'} ${c.name}${c.detail ? ` | ${c.detail}` : ''}`);
    if (!c.ok) failed += 1;
  }
  console.log(`\n核验 ${checks.length} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
})();
