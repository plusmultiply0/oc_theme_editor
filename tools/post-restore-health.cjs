/**
 * 恢复后的归档健康体检（只读）。
 * 用修复后的三层校验跑一遍真实安装：完整性、共享 offset、非白名单脚本解析。
 * 这是事故恢复的最终证据：恢复后的归档必须全部通过。
 */
const path = require('node:path');
const { scanArchive, verifyIntegrity, findSharedOffsetConflicts, checkScripts } = require('../out/core/patch/archive-verify');
const { OPENCODE_DESKTOP_ADAPTER } = require('../out/adapters/opencode-desktop');
const fs = require('node:fs');

const TARGET = 'C:/Users/ylzho/AppData/Local/Programs/@opencode-aidesktop/resources/app.asar';
const RESULT = path.join(__dirname, 'post-restore-health.json');

(async () => {
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  };

  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(TARGET)).digest('hex');
  add('归档哈希与恢复快照一致', hash === '1c53ca2472698a9e5ea1162ccb917a98b4e3f8d99ddd427b488dd063ddee6fc2', hash);

  const scan = scanArchive(TARGET);
  add('scanArchive 可解析归档头', scan.success, scan.success ? `${scan.data.entries.size} 条目` : scan.error.message);
  if (!scan.success) return finish();

  const integrity = await verifyIntegrity(scan.data);
  add('逐条完整性', integrity.success, integrity.success ? `检查 ${integrity.data.checked} 条` : `${integrity.error.message} | ${integrity.error.detail ?? ''}`);

  const shared = findSharedOffsetConflicts(scan.data);
  add('共享 offset 一致性', shared.success, shared.success ? '无冲突' : shared.error.detail ?? shared.error.message);

  const isAllowed = (e) => OPENCODE_DESKTOP_ADAPTER.allowedChanges.includes(e);
  const scripts = await checkScripts(scan.data, { isAllowed });
  add(
    '非白名单脚本解析（含 jsonfile）',
    scripts.success,
    scripts.success ? `解析 ${scripts.data.checked}，跳过 ${scripts.data.skipped}，不支持 ${scripts.data.unsupported}` : `${scripts.error.message} | ${scripts.error.detail ?? ''}`,
  );

  // 事故主角：jsonfile/index.js 必须能解析并且是完整实现（2838 字节版或 2014 字节版都应无语法错误）
  const jsonfile = scan.data.entries.get('node_modules/jsonfile/index.js');
  add('jsonfile 条目存在', Boolean(jsonfile), jsonfile ? `size=${jsonfile.size}` : 'missing');

  finish();

  function finish() {
    const payload = {
      ranAt: new Date().toISOString(),
      target: TARGET,
      checks,
      failed: checks.filter((c) => !c.ok).length,
      total: checks.length,
    };
    fs.writeFileSync(RESULT, JSON.stringify(payload, null, 2), 'utf8');
    for (const c of checks) console.log(`${c.ok ? '[OK]  ' : '[FAIL]'} ${c.name}${c.detail ? ` | ${c.detail}` : ''}`);
    console.log(`POST_RESTORE_HEALTH ${payload.failed === 0 ? 'PASS' : 'FAIL'} (${payload.total - payload.failed}/${payload.total})`);
    process.exit(payload.failed === 0 ? 0 : 1);
  }
})();
