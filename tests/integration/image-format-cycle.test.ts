/**
 * 格式轮换的完整闭环（T3）。
 *
 * 在临时合成安装上走一遍真实服务层：
 *   .jfif → .png → .webp → 同图重复应用（no-op）→ 恢复上一主题 → 恢复到首次接管
 *
 * 判据不是「Promise 成功了」，而是：归档里那个背景条目的**字节等于当次图片**、
 * HTML 里本工具链接始终唯一、no-op 不改盘也不新增事务、恢复后指纹逐级回退。
 *
 * 说明（当前已知设计，见 NEXT_EXECUTION_PLAN 第 3 节 A）：适配器固定写入
 * `oc-theme-background.jpg`，因此非 JPEG 内容也会落在 .jpg 名字里。
 * 规范化与改后缀属于第二批 T4/T6，这里按**当前行为**断言并留痕，
 * 顺带确保「换内容不换名字」不会让校验误判。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFile, uncache } from '@electron/asar';
import { afterEach, describe, expect, it } from 'vitest';
import { ImageStore } from '../../src/main/services/image-store';
import { TargetService } from '../../src/main/services/target-service';
import { OperationService } from '../../src/main/services/operation-service';
import { OperationEventBus } from '../../src/main/services/events';
import { readAsar, sha256File, toArchivePath } from '../../src/core/patch/asar';
import { listTx } from '../../src/core/patch/txlog';
import { instanceIdFromPath } from '../../src/core/patch/paths';
import { runtimeDirs } from '../../src/core/patch/layout';
import { ADAPTER } from './helpers/adapter';
import { makeSyntheticInstall, type SyntheticInstall } from '../fixtures/synthetic-install';
import { jpegBytes, pngBytes, webpBytes } from '../fixtures/image-samples';
import type { ThemeSpec } from '../../src/shared/schema';

const idle = async () => 'idle' as const;
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()?.();
    } catch {
      // 清理失败不影响判定
    }
  }
});

function specOf(imageId: string, palette: string[]): ThemeSpec {
  return {
    schemaVersion: 1,
    imageId,
    mode: 'light',
    palette,
    overlayOpacity: 0.5,
    panelOpacity: 0.4,
    blurPx: 0,
    reducedTransparency: false,
  };
}

describe('格式轮换闭环（合成安装）', () => {
  it('.jfif → .png → .webp → 同图 no-op → 恢复上一主题 → 恢复首次接管', async () => {
    const install: SyntheticInstall = await makeSyntheticInstall();
    cleanups.push(install.cleanup);
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-cycle-'));
    cleanups.push(() => fs.rmSync(runtime, { recursive: true, force: true, maxRetries: 3 }));

    // 三个不同格式的样本，各自写进临时目录模拟用户选中的文件
    const samplesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-cycle-files-'));
    cleanups.push(() => fs.rmSync(samplesDir, { recursive: true, force: true, maxRetries: 3 }));
    const jfif = path.join(samplesDir, 'wallpaper.jfif');
    const png = path.join(samplesDir, 'wallpaper.png');
    const webp = path.join(samplesDir, 'wallpaper.webp');
    const jfifBytes = await jpegBytes({ jfif: true, accent: true });
    const pngBuf = await pngBytes({ accent: true, color: { r: 20, g: 140, b: 90 } });
    const webpBuf = await webpBytes({ accent: true, color: { r: 150, g: 60, b: 40 } });
    fs.writeFileSync(jfif, jfifBytes);
    fs.writeFileSync(png, pngBuf);
    fs.writeFileSync(webp, webpBuf);

    let nextPick = jfif;
    const images = new ImageStore({
      runtimeRoot: runtime,
      picker: async () => [nextPick],
    });
    const targets = new TargetService({
      localAppData: path.join(runtime, 'no-such-local'),
      extraRoots: [install.root],
      useRegistry: false,
    });
    const operations = new OperationService({
      runtimeRoot: runtime,
      targets,
      images,
      bus: new OperationEventBus(),
      probe: idle,
    });

    const discovered = await targets.discover();
    if (!discovered.success) throw new Error('识别失败');
    const target = discovered.data.targets[0];
    const layout = runtimeDirs(runtime, instanceIdFromPath(target.installPath));

    const originalHash = await sha256File(install.archivePath);
    const imageEntry = ADAPTER.injection.imageFile;
    const htmlEntry = ADAPTER.injection.htmlEntry;

    // asar 内部条目名在 Windows 上是反斜杠形式，取值要走 toArchivePath
    const readEntryBytes = (entry: string): Buffer => {
      uncache(install.archivePath);
      return extractFile(install.archivePath, toArchivePath(entry));
    };
    const readEntryText = (entry: string): string => readEntryBytes(entry).toString('utf8');

    /** 选图 → 导入 → 准备 → 应用，返回该次应用后的归档指纹与操作 ID */
    const applyImage = async (file: string): Promise<{ hash: string; operationId: string }> => {
      nextPick = file;
      const picked = await images.pick();
      expect(picked.success, `选中 ${path.basename(file)} 失败`).toBe(true);
      if (!picked.success) throw new Error('pick failed');
      const imported = await images.import(picked.data.imageId);
      expect(imported.success, `导入 ${path.basename(file)} 失败`).toBe(true);
      if (!imported.success) throw new Error('import failed');

      const staged = await operations.stage({
        targetId: target.targetId,
        imageId: picked.data.imageId,
        spec: specOf(picked.data.imageId, imported.data.palette),
      });
      expect(staged.success, `准备失败：${staged.success ? '' : staged.error.message}`).toBe(true);
      if (!staged.success) throw new Error('stage failed');

      const applied = await operations.apply({ operationId: staged.data.operationId });
      expect(applied.success, `应用失败：${applied.success ? '' : applied.error.message}`).toBe(true);
      if (!applied.success) throw new Error('apply failed');

      // HTML 里本工具链接始终恰好一个（连续换图不该叠加）
      const html = readEntryText(htmlEntry);
      expect(html.match(/<link[^>]*oc-theme-custom\.css[^>]*>/g) ?? []).toHaveLength(1);
      return { hash: await sha256File(install.archivePath), operationId: applied.data.operationId };
    };

    // ---------- 1. .jfif ----------
    const { hash: hashAfterJfif } = await applyImage(jfif);
    expect(hashAfterJfif).not.toBe(originalHash);
    expect(readEntryBytes(imageEntry).equals(jfifBytes)).toBe(true);
    expect(readEntryText(ADAPTER.injection.cssFile)).toContain('html:root');

    // ---------- 2. .png ----------
    const { hash: hashAfterPng } = await applyImage(png);
    expect(hashAfterPng).not.toBe(hashAfterJfif);
    expect(readEntryBytes(imageEntry).equals(pngBuf)).toBe(true);

    // ---------- 3. .webp ----------
    const { hash: hashAfterWebp, operationId: webpOperationId } = await applyImage(webp);
    expect(hashAfterWebp).not.toBe(hashAfterPng);
    expect(readEntryBytes(imageEntry).equals(webpBuf)).toBe(true);

    // ---------- 4. 同图重复应用：no-op ----------
    const txBefore = (await listTx(layout.txDir)).length;
    nextPick = webp;
    const pickedAgain = await images.pick();
    if (!pickedAgain.success) throw new Error('pick failed');
    const importedAgain = await images.import(pickedAgain.data.imageId);
    if (!importedAgain.success) throw new Error('import failed');
    const stagedAgain = await operations.stage({
      targetId: target.targetId,
      imageId: pickedAgain.data.imageId,
      spec: specOf(pickedAgain.data.imageId, importedAgain.data.palette),
    });
    if (!stagedAgain.success) throw new Error('stage failed');
    const appliedAgain = await operations.apply({ operationId: stagedAgain.data.operationId });
    expect(appliedAgain.success).toBe(true);
    if (appliedAgain.success) {
      /*
       * 服务层返回的是 manifest（没有 noop 字段），所以用三条事实判定 no-op：
       * 复用同一条已应用记录、指纹没变、没有新增事务。
       */
      expect(appliedAgain.data.operationId).toBe(webpOperationId);
      expect(appliedAgain.data.afterHash).toBe(hashAfterWebp);
      expect(appliedAgain.data.status).toBe('applied');
    }
    expect(await sha256File(install.archivePath)).toBe(hashAfterWebp);
    expect((await listTx(layout.txDir)).length).toBe(txBefore);
    expect(readEntryBytes(imageEntry).equals(webpBuf)).toBe(true);

    // ---------- 5. 恢复上一主题：回到 .png 那次的状态 ----------
    const backToPng = await operations.restore({ targetId: target.targetId, kind: 'previous' });
    expect(backToPng.success, backToPng.success ? '' : backToPng.error.message).toBe(true);
    expect(await sha256File(install.archivePath)).toBe(hashAfterPng);
    expect(readEntryBytes(imageEntry).equals(pngBuf)).toBe(true);

    // ---------- 6. 恢复到首次接管：回到最初的归档 ----------
    const toTakeover = await operations.restore({ targetId: target.targetId, kind: 'takeover' });
    expect(toTakeover.success, toTakeover.success ? '' : toTakeover.error.message).toBe(true);
    expect(await sha256File(install.archivePath)).toBe(originalHash);

    // 归档仍然可解析（恢复后不是坏档）
    const snapshot = await readAsar(install.archivePath);
    expect(snapshot.success).toBe(true);
  }, 120_000);
});
