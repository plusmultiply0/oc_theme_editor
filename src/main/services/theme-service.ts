/**
 * 主题生成服务（T22、T23、T25、T53）。
 *
 * 预览与真正写入归档的 CSS 出自同一次 generateTheme 调用，
 * 界面看到的 token 与应用写进去的 token 是同一份数据。
 */
import path from 'node:path';
import { fail, ok, type Result } from '../../shared/errors';
import type { AnalyzeContrastInput, GenerateThemeInput, GenerateThemeOutput } from '../../shared/ipc';
import type { ContrastReport } from '../../shared/schema';
import { ThemeSpecSchema, ThemeTokensSchema } from '../../shared/schema';
import { generateTheme } from '../../core/theme/generate';
import { buildContrastReport } from '../../core/theme/report';
import { effectiveBackground, hexToRgb, rgbToHex } from '../../core/theme/contrast';
import { panelAlpha } from '../../core/theme/surfaces';
import { OPENCODE_DESKTOP_ADAPTER } from '../../adapters/opencode-desktop';
import type { ImageStore } from './image-store';

/** CSS 位于 out/renderer/，背景图与它同级，因此引用是同目录相对路径 */
export function defaultImageRef(): string {
  return `./${path.posix.basename(OPENCODE_DESKTOP_ADAPTER.injection.imageFile)}`;
}

export class ThemeService {
  constructor(private readonly images: ImageStore) {}

  async generate(input: GenerateThemeInput): Promise<Result<GenerateThemeOutput>> {
    const parsed = ThemeSpecSchema.safeParse(input?.spec);
    if (!parsed.success) {
      return fail('INVALID_PARAMS', '主题参数不合法', '请重置为默认参数后重试。', parsed.error.message);
    }
    if (parsed.data.imageId !== input.imageId) {
      return fail('INVALID_PARAMS', '图片标识与参数不一致', '请重新生成主题。');
    }

    const bytes = await this.images.readBytes(input.imageId);
    if (!bytes.success) return bytes;

    const r = await generateTheme({
      buffer: bytes.data,
      spec: parsed.data,
      imageRef: defaultImageRef(),
      ...(parsed.data.primary ? { primaryOverride: parsed.data.primary } : {}),
    });
    if (!r.success) return r;

    return ok({
      tokens: r.data.tokens,
      css: r.data.css,
      effectiveBackground: r.data.effectiveBackground,
      report: r.data.report,
      mode: r.data.mode,
      palette: r.data.palette,
    });
  }

  /**
   * 用界面当前 token 与参数重算报告。
   * 不重新解码图片：代表色来自 spec.palette，合成只依赖 spec 的不透明度参数，
   * 与生成阶段用的是同一套层级模型（surfaces.ts）。
   */
  async analyze(input: AnalyzeContrastInput): Promise<Result<ContrastReport>> {
    const specParsed = ThemeSpecSchema.safeParse(input?.spec);
    const tokenParsed = ThemeTokensSchema.safeParse(input?.tokens);
    if (!specParsed.success || !tokenParsed.success) {
      return fail('INVALID_PARAMS', '参数或配色不合法', '请重新生成主题。');
    }
    const spec = specParsed.data;
    const tokens = tokenParsed.data;

    const dominant = hexToRgb(spec.palette[0] ?? '#808080');
    const effective = rgbToHex(
      effectiveBackground(
        dominant,
        hexToRgb(tokens.background),
        spec.overlayOpacity,
        hexToRgb(tokens.panel),
        panelAlpha(spec),
      ),
    );

    return ok(
      buildContrastReport({
        tokens,
        spec,
        imageSamples: spec.palette.map((c) => hexToRgb(c)),
        effective,
      }),
    );
  }
}
