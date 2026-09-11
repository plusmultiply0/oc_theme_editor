/**
 * 交付前自检（T61）。
 *
 * 检查项：
 *   1. 源码/文档里不含作者专属绝对路径与用户名
 *   2. 不含密钥、私钥、长 Token 等凭证形态
 *   3. 产物里不含归档、备份、个人图片
 *   4. 直接依赖的许可证可追溯，GPL/LGPL/AGPL 单独列出（不静默放过）
 *   5. IPC 通道三处一致：契约声明、preload 暴露、主进程注册
 *
 * 退出码：0 全部通过；1 存在 FAIL。
 * 用法：npm run audit
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'tests', 'tools', 'docs', 'handoff'];
const SCAN_FILES = ['package.json', 'README.md', '.gitignore', 'eslint.config.mjs'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'release', 'dist', '.workbuddy', 'backups']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.json', '.md', '.css', '.html', '.yml', '.yaml']);

const findings = [];
const add = (level, id, detail) => findings.push({ level, id, detail });

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (TEXT_EXT.has(path.extname(name).toLowerCase())) out.push(full);
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

// 1 + 2：路径与凭证
/**
 * 只抓「真实」的绝对路径：测试与文档里允许出现占位用户名，
 * 否则这条规则会淹没在噪声里，反而看不出真正的泄漏。
 */
const PLACEHOLDER_USERS = '(?:someone|username|user|name|yourname|<[^>]+>|\\$\\{[^}]+\\})';
const PATH_PATTERNS = [
  { id: 'ABS_WIN_USER', re: new RegExp(`[A-Za-z]:[\\\\/]+Users[\\\\/]+(?!${PLACEHOLDER_USERS})[A-Za-z0-9._-]+`, 'i') },
  { id: 'ABS_WORKSPACE', re: /[A-Za-z]:[\\/]+zjcfile/i },
];
const USER_PATTERNS = [{ id: 'USERNAME', re: /\bylzho\b/i }];
const SECRET_PATTERNS = [
  { id: 'OPENAI_KEY', re: /sk-[A-Za-z0-9]{20,}/ },
  { id: 'GITHUB_TOKEN', re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { id: 'AWS_KEY', re: /AKIA[0-9A-Z]{16}/ },
  { id: 'PRIVATE_KEY', re: /-----BEGIN [A-Z ]*PRIVATE KEY/ },
  { id: 'GOOGLE_KEY', re: /AIza[0-9A-Za-z_-]{30,}/ },
  { id: 'BEARER', re: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
];

const files = [
  ...SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d))),
  ...SCAN_FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
];

/**
 * 路径/用户名规则的豁免清单（凭证规则一律照查，不豁免）。
 *
 * 理由：这两类内容**故意**记录真实路径，而且不随交付物分发——
 * - tools/ 下的诊断结果 JSON 与截图：本地跑一次就生成一份，内容就是本机路径；
 * - handoff/：内部交接与审查留档，审查本来就要求写明实际项目位置。
 * 把它们当成泄漏只会让这条规则淹没在噪声里，真正的泄漏反而看不见。
 */
const LOCAL_ONLY_ARTIFACTS = [
  /^tools\/[^/]*result[^/]*\.json$/i,
  /^tools\/[^/]*\.png$/i,
  // 恢复后体检：脚本与结果都只在本机跑，路径指向真实安装是它的本职
  /^tools\/post-restore-health\.(cjs|json)$/i,
];
const AUDIT_TRAIL = [/^handoff\//];
const exemptFromPathRules = (r) =>
  LOCAL_ONLY_ARTIFACTS.some((re) => re.test(r)) || AUDIT_TRAIL.some((re) => re.test(r));

const exemptions = new Set();

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const r = rel(file);
  const skipPathRules = exemptFromPathRules(r);
  if (skipPathRules) exemptions.add(r);
  const patterns = skipPathRules
    ? SECRET_PATTERNS
    : [...PATH_PATTERNS, ...USER_PATTERNS, ...SECRET_PATTERNS];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const p of patterns) {
      if (p.re.test(line)) add('FAIL', p.id, `${r}:${i + 1} → ${line.trim().slice(0, 120)}`);
    }
  });
}

// 3：产物
const OUT = path.join(ROOT, 'out');
if (fs.existsSync(OUT)) {
  const bad = [];
  (function scan(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        if (/^(backups|instances)$/i.test(name)) bad.push(rel(full));
        else scan(full);
        continue;
      }
      if (/\.(asar|jpg|jpeg|png|webp)$/i.test(name)) bad.push(rel(full));
    }
  })(OUT);
  if (bad.length) add('FAIL', 'ARTIFACT_LEAK', `产物中包含归档/备份/图片：${bad.join('、')}`);
} else {
  add('WARN', 'ARTIFACT_MISSING', '未找到 out/，未检查产物（请先 npm run build）');
}

// 4：依赖许可
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const shipped = { ...(pkg.dependencies || {}) };
if (pkg.devDependencies && pkg.devDependencies.electron) shipped.electron = pkg.devDependencies.electron;
const licenses = [];
for (const name of Object.keys(shipped)) {
  const p = path.join(ROOT, 'node_modules', name, 'package.json');
  if (!fs.existsSync(p)) {
    add('WARN', 'LICENSE_UNKNOWN', `${name} 未安装，无法读取许可证`);
    continue;
  }
  const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
  const license = meta.license || (meta.licenses && meta.licenses[0] && meta.licenses[0].type) || 'UNKNOWN';
  licenses.push({ name, version: meta.version, license });
  if (license === 'UNKNOWN') add('WARN', 'LICENSE_UNKNOWN', `${name} 许可证字段缺失`);
  if (/GPL/i.test(String(license)) && !/LGPL/i.test(String(license))) {
    add('WARN', 'LICENSE_GPL', `${name} 使用 ${license}，分发前需确认义务`);
  }
  if (/LGPL|AGPL/i.test(String(license))) {
    add('WARN', 'LICENSE_WEAK_COPYLEFT', `${name} 使用 ${license}，静态链接时需确认义务`);
  }
}

// 5：IPC 三处一致
const ipcSrc = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'ipc.ts'), 'utf8');
const channels = [...ipcSrc.matchAll(/^\s*'([a-zA-Z]+)',$/gm)].map((m) => m[1]);
const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.ts'), 'utf8');
const mainIpc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.ts'), 'utf8');
if (channels.length === 0) add('FAIL', 'IPC_EMPTY', '未从 contracts 中解析到任何通道');
for (const ch of channels) {
  if (!preload.includes(`'${ch}'`)) add('FAIL', 'IPC_PRELOAD_MISSING', `preload 未暴露 ${ch}`);
  if (!mainIpc.includes(`ipcMain.handle('${ch}'`)) add('FAIL', 'IPC_HANDLER_MISSING', `主进程未注册 ${ch}`);
}
// renderer 不得出现任意 ipcRenderer 调用
if (/ipcRenderer/.test(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'App.tsx'), 'utf8'))) {
  add('FAIL', 'IPC_RENDERER_DIRECT', 'renderer 直接引用了 ipcRenderer');
}

const fails = findings.filter((f) => f.level === 'FAIL');
const warns = findings.filter((f) => f.level === 'WARN');

console.log('== 依赖许可 ==');
for (const l of licenses) console.log(`  ${l.name}@${l.version}  ${l.license}`);
console.log(`\n== IPC 通道（${channels.length}）==`);
console.log(`  ${channels.join('、')}`);
console.log('\n== 结论 ==');
for (const f of findings) console.log(`  [${f.level}] ${f.id}: ${f.detail}`);
if (exemptions.size > 0) {
  console.log('\n== 路径/用户名规则豁免（本地诊断产物与内部交接留档，凭证规则仍照查）==');
  for (const e of [...exemptions].sort()) console.log(`  ~ ${e}`);
}
console.log(`\nFAIL ${fails.length} 项，WARN ${warns.length} 项`);

process.exit(fails.length === 0 ? 0 : 1);
