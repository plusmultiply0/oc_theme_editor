/**
 * 当前候选入口一致性核对（复审 F1）。
 *
 * 为什么需要这个脚本：发布文档里的「当前候选」是人工抄写的 zip 名与 SHA256。
 * 一旦重封 / 重建，人工抄写必然滞后 —— README 会把人指向旧包，
 * 把最新源码的验证结论错误地套给旧二进制。这正是 F1 的成因。
 * 本脚本把这件事变成**可机器核对**的：
 *
 *     文档里的当前候选块  ==  选中 manifest  ==  磁盘上的真实产物
 *
 * 三条硬规则：
 *   1) manifest 必须显式给出（`--manifest`），**不回落**根目录旧
 *      `candidate-manifest.json` —— 与仓库其它发布工具一致：不接受
 *      「声明了一个目标、实际核验另一个」。
 *   2) 文档里「当前候选」块必须**唯一**。出现两个就是有歧义，直接失败。
 *   3) 磁盘哈希**实算**并与 manifest 比对：manifest 本身也是被核验对象，
 *      不是权威。任何一方不符都失败。
 *
 * 用法：
 *   node tools/doc-candidate-entry.cjs --manifest <路径>                  # 打印规范块
 *   node tools/doc-candidate-entry.cjs --manifest <路径> --check          # 核对默认文档
 *   node tools/doc-candidate-entry.cjs --manifest <路径> --check --doc <文件>  # 只查指定文档
 *
 * 退出码：0 一致；1 不一致或缺少产物；2 参数错误。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

const BEGIN = '<!-- CURRENT-CANDIDATE:BEGIN -->';
const END = '<!-- CURRENT-CANDIDATE:END -->';

/** 候选包内固定文件名（与 adapters/opencode-desktop 的布局声明一致） */
const EXE_REL = 'OpenCodeThemeSwitcher.exe';
const ASAR_REL = path.join('resources', 'app.asar');

/**
 * 默认要核对的文档。
 * - `release-checklist.md`：**唯一**携带机器可核对块（含哈希），是权威入口；
 * - `README.md` / `alpha-acceptance.md`：必须出现同一个 buildId，
 *   否则就是「重封后只更新了一处」的典型漂移。
 */
const DEFAULT_DOCS = ['README.md', 'docs/release-checklist.md', 'docs/alpha-acceptance.md'];
/** 只有在这些文档里要求存在机器块（其余只要求 buildId 一致） */
const BLOCK_DOCS = ['docs/release-checklist.md'];

/** 块内字段顺序固定，便于人工阅读与 diff */
const FIELDS = [
  'buildId',
  'sourceCommit',
  'schema',
  'packMethod',
  'manifest',
  'candidateDir',
  'zip',
  'zipSha256',
  'exeSha256',
  'asarSha256',
];

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      h.update(chunk.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** 相对仓库根的正斜杠路径（文档里不写本机绝对路径） */
function rel(p, root = ROOT) {
  return path.relative(root, path.resolve(root, p)).split(path.sep).join('/');
}

/**
 * 从选中 manifest + 磁盘实际产物推导出规范块。
 * 返回 { entry, problems }：problems 非空表示 manifest 与磁盘不符（不抛出，
 * 让调用方能把全部问题一次报出来）。
 */
function entryFromManifest(manifestPath, opts = {}) {
  const root = opts.root || ROOT;
  const hash = opts.sha256File || sha256File;
  const problems = [];

  const abs = path.resolve(root, manifestPath);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return { entry: null, problems: [`manifest 无法读取或不是合法 JSON：${rel(manifestPath, root)}（${e.message}）`] };
  }

  const buildId = m.buildId || '';
  // candidateDir / zip 优先取 manifest 登记值；缺失时按 buildId 推导
  const candidateDir = m.candidateDir || (buildId ? `candidate-${buildId}/win-unpacked` : '');
  const zip = m.zip || (buildId ? `candidate-${buildId}.zip` : '');
  const hashes = m.hashes || {};

  const expected = {
    buildId,
    sourceCommit: m.sourceCommit || '',
    schema: m.schema || '',
    packMethod: m.packMethod || '',
    manifest: rel(manifestPath, root),
    candidateDir,
    zip,
  };

  if (!buildId) problems.push('manifest 缺少 buildId');
  if (!expected.sourceCommit) problems.push('manifest 缺少 sourceCommit');
  if (!expected.schema) problems.push('manifest 缺少 schema');
  if (!candidateDir) problems.push('manifest 缺少 candidateDir，且无法由 buildId 推导');
  if (!zip) problems.push('manifest 缺少 zip，且无法由 buildId 推导');

  /**
   * 逐个实算磁盘哈希。
   * 这里的比对方向是刻意的：**先算磁盘、再和登记比**，
   * 所以「登记写错」和「文件被换掉」都会被抓到。
   */
  const diskTargets = [
    { field: 'zipSha256', abs: path.resolve(root, zip), registered: hashes.zip, label: '分发 zip' },
    { field: 'exeSha256', abs: path.resolve(root, candidateDir, EXE_REL), registered: hashes.exe, label: '可执行文件' },
    {
      field: 'asarSha256',
      abs: path.resolve(root, candidateDir, ASAR_REL),
      registered: hashes['app.asar'],
      label: 'app.asar',
    },
  ];
  for (const t of diskTargets) {
    if (!zip || !candidateDir) {
      expected[t.field] = '';
      continue;
    }
    if (!fs.existsSync(t.abs)) {
      expected[t.field] = '';
      problems.push(`缺少产物：${rel(t.abs, root)}（${t.label}）`);
      continue;
    }
    const actual = hash(t.abs);
    expected[t.field] = actual;
    if (!t.registered) {
      problems.push(`manifest 未登记 ${t.field}（${t.label}）`);
    } else if (t.registered !== actual) {
      problems.push(
        `manifest 登记的 ${t.field} 与磁盘不符（${t.label}）：登记 ${t.registered} / 磁盘 ${actual}`,
      );
    }
  }

  return { entry: expected, problems };
}

/** 把规范块渲染成文档片段 */
function renderEntryBlock(entry) {
  const lines = [BEGIN];
  for (const f of FIELDS) lines.push(`${f}: ${entry[f] ?? ''}`);
  lines.push(END);
  return lines.join('\n');
}

/**
 * 从文档文本里抽出候选块。
 * 返回 { entries, problems }：entries 是解析成功的块（可能 0、1 或多个）。
 */
function parseEntryBlocks(text) {
  const problems = [];
  const entries = [];
  let from = 0;
  for (;;) {
    const b = text.indexOf(BEGIN, from);
    if (b < 0) break;
    const e = text.indexOf(END, b);
    if (e < 0) {
      problems.push('候选块缺少结束标记（CURRENT-CANDIDATE:END）');
      break;
    }
    const body = text.slice(b + BEGIN.length, e);
    const obj = {};
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const i = line.indexOf(':');
      if (i < 0) {
        problems.push(`候选块存在无法解析的行：${line}`);
        continue;
      }
      obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const missing = FIELDS.filter((f) => !(f in obj));
    if (missing.length) problems.push(`候选块缺少字段：${missing.join('、')}`);
    entries.push(obj);
    from = e + END.length;
  }
  return { entries, problems };
}

/** 逐字段比较实际块与期望块 */
function diffEntry(expected, actual) {
  const problems = [];
  for (const f of FIELDS) {
    const a = actual[f];
    const b = expected[f];
    if (a === undefined) continue; // 缺字段已由 parseEntryBlocks 报出
    if (a !== b) problems.push(`${f} 不一致：文档 ${a || '(空)'} / 应为 ${b || '(空)'}`);
  }
  return problems;
}

/** 核对单个文档；返回问题列表 */
function checkDocs(docs, expected, opts = {}) {
  const root = opts.root || ROOT;
  const problems = [];
  for (const d of docs) {
    const abs = path.resolve(root, d);
    if (!fs.existsSync(abs)) {
      problems.push(`${d}：文件不存在`);
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    const { entries, problems: parseProblems } = parseEntryBlocks(text);
    for (const p of parseProblems) problems.push(`${d}：${p}`);

    if (BLOCK_DOCS.includes(d.split(path.sep).join('/'))) {
      if (entries.length === 0) {
        problems.push(`${d}：缺少「当前候选」机器块（${BEGIN}）`);
      } else if (entries.length > 1) {
        problems.push(`${d}：存在 ${entries.length} 个「当前候选」块，入口必须唯一`);
      } else {
        for (const p of diffEntry(expected, entries[0])) problems.push(`${d}：${p}`);
      }
    }

    // 所有被核对的文档都必须出现同一个 buildId：
    // 只更新一处 = 典型漂移，这里直接失败
    if (expected.buildId && !text.includes(expected.buildId)) {
      problems.push(`${d}：未出现当前 buildId=${expected.buildId}（重封后只更新了部分文档？）`);
    }
  }
  return problems;
}

module.exports = {
  BEGIN,
  END,
  FIELDS,
  DEFAULT_DOCS,
  BLOCK_DOCS,
  sha256File,
  entryFromManifest,
  renderEntryBlock,
  parseEntryBlocks,
  diffEntry,
  checkDocs,
};

// ---------------- CLI ----------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = { check: false, docs: null, manifest: null, root: ROOT };
  const problems = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') { opts.check = true; continue; }
    if (a === '--manifest' || a === '--doc' || a === '--root') {
      const v = argv[i + 1];
      // 缺值必须显式失败：旧写法 `argv[++i]` 会把「没给值」当成「没声明」
      if (v === undefined || (v.startsWith('--') && v.length > 2)) {
        problems.push(`选项 ${a} 缺少取值`);
        continue;
      }
      i += 1;
      if (a === '--manifest') opts.manifest = v;
      else if (a === '--doc') (opts.docs = opts.docs || []).push(v);
      else opts.root = path.resolve(v);
      continue;
    }
    problems.push(`未识别的参数：${a}`);
  }

  if (!opts.manifest) problems.push('必须显式给出 --manifest <路径>（不回落候选默认登记）');
  if (problems.length) {
    console.error('[FAIL] 参数错误：');
    for (const p of problems) console.error(`       ${p}`);
    console.error('用法：node tools/doc-candidate-entry.cjs --manifest <路径> [--check] [--doc <文件>]');
    process.exit(2);
  }

  const { entry, problems: deriveProblems } = entryFromManifest(opts.manifest, { root: opts.root });
  if (deriveProblems.length) {
    console.error('[FAIL] 候选身份与磁盘产物不一致：');
    for (const p of deriveProblems) console.error(`       ${p}`);
    process.exit(1);
  }

  if (!opts.check) {
    console.log('# 由 manifest + 磁盘实算得到的规范块（可直接粘进文档）');
    console.log(renderEntryBlock(entry));
    process.exit(0);
  }

  const docs = opts.docs || DEFAULT_DOCS;
  const docProblems = checkDocs(docs, entry, { root: opts.root });
  if (docProblems.length) {
    console.error('[FAIL] 文档「当前候选」入口与 manifest/磁盘不一致：');
    for (const p of docProblems) console.error(`       ${p}`);
    console.error('\n修正方式：让文档与 manifest 对齐，而不是反过来改 manifest 去迁就文档。');
    process.exit(1);
  }
  console.log(`DOC_ENTRY_OK buildId=${entry.buildId}（文档、manifest、磁盘三者一致）`);
}
