# 出厂原版指纹的登记办法

`src/core/patch/original-evidence.ts` 里的 `KNOWN_FACTORY_FINGERPRINTS` 目前是**空表**。

这不是没写完，而是刻意的诚实边界：**没有可信来源就不该假装知道原厂长什么样。**

## 为什么不能靠「没有标记」推断

旧实现的做法是：归档里没有本工具的 `oc-theme-custom.css` → 判定为出厂原版。
真机上被这条规则坑过：原型时代注入的是 `snow-theme.css`，对旧代码来说「看不见」，
于是那份已经被改过的安装被标成 `pristine: true`，「恢复原版」实际回退到旧定制界面。

结论：**原版必须由外部证据证明**，不能靠某个标记缺失反推。

## 判定顺序

1. **命中已登记指纹** → `evidence = 'factory'`，允许出现「恢复原版」入口。
2. 否则 → `evidence = 'unverified'`，记录降级为「首次接管快照」，
   「恢复原版」入口**不出现**，但快照本身仍可恢复（入口名写明它不是出厂界面）。

## 怎么登记一条指纹

1. 从**可信来源**取得该版本的官方安装包（官方发布页 / 官方校验记录），
   不要用本机正在运行的安装，也不要让工具自己去下载覆盖当前安装。
2. 计算 `resources/app.asar` 的 SHA256：

   ```bash
   node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex'))" "<官方安装包内解出的 app.asar 路径>"
   ```

3. 把版本号、指纹、出处、登记日期写进 `KNOWN_FACTORY_FINGERPRINTS`：

   ```ts
   export const KNOWN_FACTORY_FINGERPRINTS: FactoryFingerprint[] = [
     {
       version: '1.18.29',
       sha256: '<64 位小写十六进制>',
       source: '官方发布页 <链接> 的安装包，2026-09-11 解出 resources/app.asar',
       recordedAt: '2026-09-11',
     },
   ];
   ```

4. 补一条单测：`matchFactoryFingerprint('1.18.29', '<sha256>')` 命中，
   且换上别的哈希时不命中。

## 已经有的备份怎么办

现有备份的元数据会在读取时**自动迁移**：缺少 `evidence` 字段的 `original` 记录
一律降级为 `unverified`，并在写回前把原 `meta.json` 另存为 `meta.json.pre-r2.bak`。
备份文件本体不会被删除，恢复能力不丢。

登记了指纹之后，如果那份快照的哈希正好命中，下次读取时会自动升级为 `factory`——
不需要重装、不需要重新应用主题。
