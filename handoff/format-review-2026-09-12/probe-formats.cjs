// Read-only capability probe. Creates image buffers in memory; no install/source writes.
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(process.argv[2] || 'D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher');
const fromProject = createRequire(path.join(project, 'package.json'));
const sharp = fromProject('sharp');
const { analyzeImage } = require(path.join(project, 'out/core/theme/generate.js'));
const { ImageStore, ALLOWED_EXTENSIONS } = require(path.join(project, 'out/main/services/image-store.js'));
const { scanArchive } = require(path.join(project, 'out/core/patch/archive-verify.js'));
const fs = require('node:fs');
const crypto = require('node:crypto');
async function main() {
  const evidence = { versions: sharp.versions, decoders: {}, formats: [], jfif: {}, installedImage: {} };
  for (const key of ['jpeg','png','webp','gif','tiff','heif','svg','magick']) evidence.decoders[key] = sharp.format[key]?.input;
  for (const format of ['jpeg','png','webp','gif','tiff','avif']) {
    try {
      const bytes = await sharp({ create: { width: 24, height: 18, channels: 3, background: '#4688bd' } }).toFormat(format).toBuffer();
      const metadata = await sharp(bytes).metadata();
      await sharp(bytes).raw().toBuffer();
      const analysis = await analyzeImage(bytes);
      evidence.formats.push({ format, byteLength: bytes.length, decodedAs: metadata.format, analysis });
      if (format === 'jpeg' && !ALLOWED_EXTENSIONS.includes('.jfif')) {
        // Current implementation rejects .jfif before any filesystem access.
        const store = new ImageStore({ runtimeRoot: path.join(__dirname, 'unused-runtime'), picker: async () => ['C:/not-accessed/example.JFIF'] });
        evidence.jfif.pick = await store.pick();
        evidence.jfif.drag = await store.importData('example.jfif', bytes);
      }
    } catch (e) { evidence.formats.push({ format, error: String(e) }); }
  }
  const archive = 'C:/Users/ylzho/AppData/Local/Programs/@opencode-aidesktop/resources/app.asar';
  const snapshot = scanArchive(archive);
  if (!snapshot.success) throw new Error('Cannot scan installed archive');
  const entry = snapshot.data.entries.get('out/renderer/oc-theme-background.jpg');
  if (!entry) throw new Error('No installed background');
  const bytes = Buffer.alloc(entry.size); const fd = fs.openSync(archive, 'r');
  try { fs.readSync(fd, bytes, 0, entry.size, snapshot.data.dataStart + Number(entry.offset)); }
  finally { fs.closeSync(fd); }
  const meta = await sharp(bytes).metadata(); await sharp(bytes).raw().toBuffer();
  evidence.installedImage = { format: meta.format, width: meta.width, height: meta.height, fullDecode: true, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(evidence, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(evidence, null, 2));
}
const timer = setTimeout(() => { console.error('Probe timed out'); process.exit(2); }, 45000);
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => clearTimeout(timer));
