/**
 * 「是不是出厂原版」的证据判定（R2）。
 *
 * 旧实现犯的错：`alreadyPatched` 只检查本工具的 `oc-theme-custom.css` 在不在归档里，
 * 不在就 `pristine = true`。可是原型时代注入的是 `snow-theme.css`——对旧代码来说「看不见」，
 * 于是真机上那份已经被改过的安装被标成原版，`恢复原版` 实际回退到旧定制界面。
 *
 * 正确做法：原版必须由**可信来源**证明，目前只有一条可用证据——
 * 维护者核实并登记过的「版本 → app.asar SHA256」出厂指纹表。
 * 拿不出证据就如实记为未验证快照，不靠标记缺失反推。
 *
 * 指纹表为空不是缺陷，而是诚实边界：没有可信来源就不该假装知道原厂长什么样。
 * 补录方式见 docs/original-evidence.md。
 */
import type { TargetAdapter } from '../../adapters/types';
import { detectInjectionMarkers, type InjectionMarkers } from './legacy-theme';

/**
 * 原版判定的证据等级；没有证据就不允许出现「恢复原版」入口。
 * 这个词表放在这里（而不是 backup.ts），是为了让「判定」与「存储」只有单向依赖。
 */
export type OriginalEvidence = 'factory' | 'unverified';

export interface FactoryFingerprint {
  /** 应用版本，例如 1.18.29 */
  version: string;
  /** 该版本 app.asar 的 SHA256（小写十六进制） */
  sha256: string;
  /** 证据出处：发布页 / 官方安装包文件名 / 校验记录位置 */
  source: string;
  /** 登记日期（YYYY-MM-DD） */
  recordedAt: string;
}

/**
 * 已核实的出厂指纹表。
 *
 * **当前为空**：本机没有可核实的出厂归档来源，因此任何现存备份都只能是
 * 「未验证快照」。填入条目后才可能开放「恢复原版」。
 */
export const KNOWN_FACTORY_FINGERPRINTS: FactoryFingerprint[] = [];

export interface EvidenceInput {
  version: string;
  sha256: string;
  html: string;
  adapter: TargetAdapter;
  readEntry(entry: string): Promise<string | null>;
}

export interface EvidenceAssessment {
  evidence: OriginalEvidence;
  /** 写进备份记录、界面原样展示的判定说明 */
  note: string;
  markers: InjectionMarkers;
  matched?: FactoryFingerprint;
}

export function matchFactoryFingerprint(
  version: string,
  sha256: string,
): FactoryFingerprint | undefined {
  return KNOWN_FACTORY_FINGERPRINTS.find(
    (f) => f.version === version && f.sha256.toLowerCase() === sha256.toLowerCase(),
  );
}

export async function assessOriginalEvidence(input: EvidenceInput): Promise<EvidenceAssessment> {
  const markers = await detectInjectionMarkers({
    html: input.html,
    adapter: input.adapter,
    readEntry: input.readEntry,
  });

  const matched = matchFactoryFingerprint(input.version, input.sha256);
  if (matched) {
    return {
      evidence: 'factory',
      note: `已与登记的出厂指纹一致（版本 ${matched.version}，来源：${matched.source}，登记于 ${matched.recordedAt}）。`,
      markers,
      matched,
    };
  }

  const found: string[] = [];
  if (markers.selfInjected) found.push('本工具的主题层');
  if (markers.legacyEntries.length > 0) {
    found.push(`旧主题层（${markers.legacyEntries.join('、')}）`);
  }
  if (markers.unknownCount > 0) found.push(`${markers.unknownCount} 个来源不明的样式层`);

  const detail =
    found.length > 0
      ? `当前内容里能看到 ${found.join('、')}，显然不是出厂状态。`
      : '当前内容里没有发现已知的本地主题层，但「没有标记」并不能证明它就是出厂原版。';

  return {
    evidence: 'unverified',
    note: `${detail}也没有与登记指纹表的匹配项（表内 ${KNOWN_FACTORY_FINGERPRINTS.length} 条），因此这份快照只能作为「首次接管快照」，不能当作出厂原版。`,
    markers,
  };
}
