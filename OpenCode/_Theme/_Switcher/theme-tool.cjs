const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const base = __dirname;
const appDir = process.env.OPENCODE_APP_DIR || path.join(process.env.LOCALAPPDATA || '', 'Programs', '@opencode-aidesktop');
const target = path.join(appDir, 'resources/app.asar');
const image = process.env.OPENCODE_THEME_IMAGE || '';
const imageBytes = () => (assert.ok(image, 'Set OPENCODE_THEME_IMAGE to the wallpaper file path.'), fs.readFileSync(image));
const manifestFile = path.join(base, 'backup-manifest.json');
const prefix = 'out/renderer/';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');

function archive(file) {
  const buffer = fs.readFileSync(file);
  assert.equal(buffer.readUInt32LE(0), 4);
  const start = 8 + buffer.readUInt32LE(4);
  const header = JSON.parse(buffer.subarray(16, 16 + buffer.readUInt32LE(12)).toString());
  const entries = new Map();
  function walk(node, parts = []) {
    for (const [name, value] of Object.entries(node.files || {})) {
      const next = [...parts, name];
      if (value.files) walk(value, next);
      else entries.set(next.join('/'), value);
    }
  }
  walk(header);
  return { buffer, start, header, entries, read(name) {
    const e = entries.get(name);
    assert(e && !e.unpacked && !e.link, `Missing packed entry: ${name}`);
    const offset = start + Number(e.offset);
    assert(offset + e.size <= buffer.length, `Invalid bounds: ${name}`);
    return buffer.subarray(offset, offset + e.size);
  }};
}
function pack(original, changed) {
  const header = structuredClone(original.header);
  const chunks = [original.buffer.subarray(original.start)];
  let offset = chunks[0].length;
  for (const [name, bytes] of changed) {
    const blockSize = 4194304, blocks = [];
    for (let i = 0; i < bytes.length; i += blockSize) blocks.push(hash(bytes.subarray(i, i + blockSize)));
    const parts = name.split('/');
    let node = header;
    for (const part of parts.slice(0, -1)) { node.files[part] ||= { files: {} }; node = node.files[part]; }
    node.files[parts.at(-1)] = { size: bytes.length, offset: String(offset), integrity: { algorithm: 'SHA256', hash: hash(bytes), blockSize, blocks } };
    chunks.push(bytes);
    offset += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(header));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const hp = Buffer.alloc(8 + paddedLength);
  hp.writeUInt32LE(4 + paddedLength, 0);
  hp.writeUInt32LE(json.length, 4);
  json.copy(hp, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(hp.length, 4);
  return Buffer.concat([size, hp, ...chunks]);
}
function verify(original, patched, changed) {
  let preserved = 0;
  for (const [name, entry] of original.entries) {
    if (changed.has(name)) continue;
    assert.deepEqual(patched.entries.get(name), entry, `Metadata changed: ${name}`);
    if (!entry.unpacked && !entry.link) assert(original.read(name).equals(patched.read(name)), `File changed: ${name}`);
    preserved++;
  }
  for (const [name, bytes] of changed) {
    assert(patched.read(name).equals(bytes), `Patch mismatch: ${name}`);
    assert.equal(patched.entries.get(name).integrity.hash, hash(bytes));
  }
  console.log(JSON.stringify({ verification: 'passed', entriesPreserved: preserved, changed: [...changed.keys()] }));
}
function closed() {
  const query = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${path.join(appDir, 'OpenCode.exe')}' }; if ($p) { $p | Select-Object Name,ProcessId | ConvertTo-Json -Compress; exit 9 }`;
  cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { windowsHide: true, stdio: 'pipe' });
}
function checkIntegritySetting() {
  const exe = fs.readFileSync(path.join(appDir, 'OpenCode.exe'));
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const index = exe.indexOf(sentinel);
  assert(index >= 0, 'Cannot inspect integrity setting; stopping.');
  const start = index + sentinel.length;
  assert.equal(exe[start], 1, 'Unsupported fuse version.');
  assert.equal(exe[start + 2 + 4], 48, 'ASAR integrity enforcement enabled; will not bypass it.');
}
function build() {
  checkIntegritySetting();
  const original = archive(target);
  assert(!original.entries.has(prefix + 'snow-theme.css'), 'Already patched; restore first.');
  const version = JSON.parse(original.read('package.json')).version;
  assert.equal(version, '1.18.29', 'Only validated for desktop 1.18.29.');
  const html = original.read(prefix + 'index.html').toString();
  assert(html.includes('</head>'));
  const changed = new Map([
    [prefix + 'index.html', Buffer.from(html.replace('</head>', '  <link rel="stylesheet" href="./snow-theme.css" data-local-theme="snowfield">\n  </head>'))],
    [prefix + 'snow-theme.css', fs.readFileSync(path.join(base, 'snow-theme.css'))],
    [prefix + 'snow-background.jpg', imageBytes()],
  ]);
  const staged = path.join(base, 'app.snow.asar');
  fs.writeFileSync(staged, pack(original, changed));
  verify(original, archive(staged), changed);
  return { original, staged, version };
}
function apply() {
  closed();
  assert(!fs.existsSync(manifestFile), 'Existing backup manifest; restore before reapplying.');
  const { original, staged, version } = build();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(base, 'backups', stamp, 'app.asar');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
  assert.equal(hash(fs.readFileSync(backup)), hash(original.buffer));
  const m = { target, backup, version, originalHash: hash(original.buffer), patchedHash: hash(fs.readFileSync(staged)), imageHash: hash(imageBytes()), created: stamp, status: 'prepared' };
  fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2));
  closed();
  assert.equal(hash(fs.readFileSync(target)), m.originalHash, 'App changed during preparation.');
  try {
    fs.copyFileSync(staged, target);
    assert.equal(hash(fs.readFileSync(target)), m.patchedHash);
    m.status = 'applied';
    fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2));
  } catch (e) { fs.copyFileSync(backup, target); throw e; }
  console.log(JSON.stringify(m, null, 2));
}
function update() {
  closed();
  checkIntegritySetting();
  const m = JSON.parse(fs.readFileSync(manifestFile));
  assert.equal(m.target, target);
  const current = archive(target);
  assert.equal(hash(current.buffer), m.patchedHash, 'App changed since last patch; refusing update.');
  assert.equal(hash(fs.readFileSync(m.backup)), m.originalHash, 'Original backup checksum mismatch.');
  const changed = new Map([[prefix + 'snow-theme.css', fs.readFileSync(path.join(base, 'snow-theme.css'))]]);
  assert(current.entries.has(prefix + 'snow-theme.css'));
  const next = pack(current, changed);
  const staged = path.join(base, 'app.snow.asar');
  fs.writeFileSync(staged, next);
  verify(current, archive(staged), changed);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const previous = path.join(base, 'backups', stamp, 'app.asar');
  fs.mkdirSync(path.dirname(previous), { recursive: true });
  fs.copyFileSync(target, previous, fs.constants.COPYFILE_EXCL);
  assert.equal(hash(fs.readFileSync(previous)), m.patchedHash);
  const oldManifest = fs.readFileSync(manifestFile);
  fs.copyFileSync(manifestFile, path.join(path.dirname(previous), 'manifest-before-update.json'));
  closed();
  assert.equal(hash(fs.readFileSync(target)), m.patchedHash);
  try {
    fs.copyFileSync(staged, target);
    assert.equal(hash(fs.readFileSync(target)), hash(next));
    m.revisions ||= [];
    m.revisions.push({ backup: previous, hash: m.patchedHash, created: stamp });
    m.patchedHash = hash(next);
    m.themeRevision = 2;
    m.updated = stamp;
    fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2));
  } catch (e) {
    fs.copyFileSync(previous, target);
    fs.writeFileSync(manifestFile, oldManifest);
    throw e;
  }
  console.log(JSON.stringify({ status: 'theme-updated', previous, originalBackup: m.backup, sha256: m.patchedHash }, null, 2));
}
function restore() {
  closed();
  const m = JSON.parse(fs.readFileSync(manifestFile));
  assert.equal(m.target, target);
  assert.equal(hash(fs.readFileSync(m.backup)), m.originalHash, 'Backup checksum mismatch.');
  assert([m.patchedHash, m.originalHash].includes(hash(fs.readFileSync(target))), 'Installed version changed; refusing to overwrite a later update.');
  fs.copyFileSync(m.backup, target);
  assert.equal(hash(fs.readFileSync(target)), m.originalHash);
  fs.renameSync(manifestFile, path.join(base, `backup-manifest.restored-${Date.now()}.json`));
  console.log('Original app.asar restored. User settings and history unchanged.');
}
function status() {
  const a = archive(target);
  console.log(JSON.stringify({ target, version: JSON.parse(a.read('package.json')).version, patched: a.entries.has(prefix + 'snow-theme.css'), sha256: hash(a.buffer) }, null, 2));
}
const action = process.argv[2] || 'status';
if (action === 'status') status();
else if (action === 'build') build();
else if (action === 'apply') apply();
else if (action === 'update') update();
else if (action === 'restore') restore();
else throw new Error('Use status|build|apply|update|restore');
