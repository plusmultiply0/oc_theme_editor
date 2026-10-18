/**
 * 创建 GitHub Release v1.0.1 并上传分发物（zip + 哈希侧车）。
 *
 * 凭据：`git credential fill` 内存内取用，不落盘、不打印。
 * 幂等：release 已存在则复用；同名资产已存在则跳过。
 * 核验：匿名 GET release 页 200 + zip Range 206 + 侧车逐字节一致。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const OWNER = 'plusmultiply0';
const REPO = 'oc_theme_editor';
const TAG = 'v1.0.1';
const ROOT = path.resolve(__dirname, '..');
const CAND = 'candidate-20261018022200-1a35bc5-cb8c70';

function token() {
  const r = spawnSync('git', ['credential', 'fill'], {
    cwd: ROOT,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error('git credential fill 失败：' + (r.stderr || ''));
  const m = /^password=(.+)$/m.exec(r.stdout || '');
  if (!m) throw new Error('凭据中未取到 password');
  return m[1].trim();
}

function request(method, url, { auth, body, raw, contentType, follow = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {
      'User-Agent': 'ots-release-script',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (auth) headers.Authorization = 'Bearer ' + auth;
    if (raw) {
      headers['Content-Type'] = contentType || 'application/octet-stream';
      headers['Content-Length'] = raw.length;
    }
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && follow > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(request(method, next, { auth: null, raw: null, follow: follow - 1 }));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, buf });
      });
    });
    req.setTimeout(600000, () => req.destroy(new Error('请求超时：' + url)));
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

async function main() {
  const tok = token();
  const me = await request('GET', `https://api.github.com/repos/${OWNER}/${REPO}`, { auth: tok });
  console.log(`仓库：${OWNER}/${REPO} private=${me.json && me.json.private} 权限=${me.json && me.json.permissions && JSON.stringify(me.json.permissions)}`);

  const notesPath = path.join(ROOT, 'docs', 'release-notes-1.0.1.md');
  const notes = fs.readFileSync(notesPath, 'utf8').trim();
  const assetNote =
    '\n\n---\n\n**分发物**：`' + CAND + '.zip`（127.2 MiB，82 条目整目录压缩）+ ' +
    '`' + CAND + '.zip.sha256.txt`（exe / asar / zip 三行校验和，与 zip 一同分发、不在 zip 内）。\n' +
    '未签名便携包：解压后双击 `' + CAND + '/builder-out/win-unpacked/OpenCodeThemeSwitcher.exe`。';
  const body = notes + assetNote;
  console.log(`Release 正文：${Buffer.byteLength(body, 'utf8')} 字节`);

  let rel = await request('GET', `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, { auth: tok });
  if (rel.status === 200 && rel.json) {
    console.log(`Release 已存在：id=${rel.json.id}（复用，不改正文）`);
  } else if (rel.status === 404) {
    rel = await request('POST', `https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
      auth: tok,
      raw: Buffer.from(JSON.stringify({
        tag_name: TAG,
        name: 'OpenCodeThemeSwitcher 1.0.1（正式版缺陷修复）',
        body,
        draft: false,
        prerelease: false,
      })),
      contentType: 'application/json',
    });
    if (rel.status !== 201) throw new Error(`创建 Release 失败 status=${rel.status} ${rel.buf.toString('utf8').slice(0, 400)}`);
    console.log(`Release 已创建：id=${rel.json.id} ${rel.json.html_url}`);
  } else {
    throw new Error(`查询 Release 失败 status=${rel.status} ${rel.buf.toString('utf8').slice(0, 400)}`);
  }

  const release = rel.json;
  const existing = new Set((release.assets || []).map((a) => a.name));
  const uploadBase = release.upload_url.replace(/\{\?name,label\}$/, '');
  const files = [
    [path.join(ROOT, CAND + '.zip.sha256.txt'), CAND + '.zip.sha256.txt', 'text/plain'],
    [path.join(ROOT, CAND + '.zip'), CAND + '.zip', 'application/zip'],
  ];
  for (const [file, name, type] of files) {
    if (existing.has(name)) {
      console.log(`资产已存在，跳过：${name}`);
      continue;
    }
    const buf = fs.readFileSync(file);
    const r = await request('POST', `${uploadBase}?name=${encodeURIComponent(name)}&label=${encodeURIComponent(name)}`, {
      auth: tok,
      raw: buf,
      contentType: type,
    });
    if (r.status !== 201) throw new Error(`上传失败 ${name} status=${r.status} ${r.buf.toString('utf8').slice(0, 400)}`);
    console.log(`UPLOAD_OK ${name} size=${r.json.size}（本地 ${buf.length}）${r.json.size === buf.length ? '== 本地' : '!= 本地'}`);
  }
  console.log('UPLOAD_ALL_OK');

  // 匿名核验（不带 token）
  const page = await request('GET', `https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`, { follow: 3 });
  console.log(`匿名 release 页：${page.status}`);

  const zipUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${CAND}.zip`;
  const range = await new Promise((resolve, reject) => {
    const go = (url, hops) => {
      https.get(url, { headers: { Range: 'bytes=0-1023', 'User-Agent': 'ots-release-script' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops > 0) {
          res.resume();
          go(new URL(res.headers.location, url).toString(), hops - 1);
          return;
        }
        res.resume();
        resolve({ status: res.statusCode, url });
      }).on('error', reject);
    };
    go(zipUrl, 5);
  });
  console.log(`匿名 zip Range 下载：${range.status}`);

  const sideUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${CAND}.zip.sha256.txt`;
  const side = await request('GET', sideUrl, { follow: 5 });
  const localSide = fs.readFileSync(path.join(ROOT, CAND + '.zip.sha256.txt'));
  const same = side.status === 200 && Buffer.compare(side.buf, localSide) === 0;
  console.log(`匿名侧车：status=${side.status} 逐字节一致=${same}`);

  if (page.status !== 200 || range.status !== 206 || !same) throw new Error('匿名核验未全通过');
  console.log('RELEASE_VERIFY_OK ' + release.html_url);
}

main().catch((e) => {
  console.error('RELEASE_FAILED: ' + e.message);
  process.exit(1);
});
