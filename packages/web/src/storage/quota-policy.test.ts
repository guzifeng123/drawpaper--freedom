import { describe, expect, it } from 'vitest';
import {
  classifyQuotaState,
  formatBytes,
  hasAction,
  quotaPressureRatio,
  QUOTA_CRITICAL_RATIO,
  QUOTA_WARN_RATIO,
  selectRecoveryActions,
  type RecoveryCapabilities,
} from './quota-policy';

/**
 * Wave21：配额策略纯函数单测（零 DOM，jsdom 下直接跑）。
 * 覆盖：压力比边界、estimate 不可用防御、档位分类、动作选择（Tauri 门控 /
 * 有无 Web Share / FSA 不删减动作）、字节格式化。
 */

describe('quotaPressureRatio 边界', () => {
  it('正常 usage/quota 比值', () => {
    expect(quotaPressureRatio(800, 1000)).toBeCloseTo(0.8);
  });
  it('非法输入（NaN/Infinity/负数/quota<=0）一律 0，不产出 NaN', () => {
    expect(quotaPressureRatio(NaN, 1000)).toBe(0);
    expect(quotaPressureRatio(Infinity, 1000)).toBe(0);
    expect(quotaPressureRatio(-1, 1000)).toBe(0);
    expect(quotaPressureRatio(100, 0)).toBe(0);
    expect(quotaPressureRatio(0, 0)).toBe(0);
  });
  it('usage >= quota 封顶为 1', () => {
    expect(quotaPressureRatio(5000, 1000)).toBe(1);
  });
});

describe('classifyQuotaState 档位', () => {
  it('estimate 为 null（旧 Safari 不支持 estimate）→ unavailable，绝不猜测', () => {
    expect(classifyQuotaState(null)).toBe('unavailable');
  });
  it('quota<=0 / 非有限 → unavailable', () => {
    expect(classifyQuotaState({ usage: 1, quota: 0 })).toBe('unavailable');
    expect(classifyQuotaState({ usage: NaN, quota: NaN })).toBe('unavailable');
  });
  it('低占用 → ok', () => {
    expect(classifyQuotaState({ usage: 100, quota: 1000 })).toBe('ok');
  });
  it('≥warnRatio → low', () => {
    expect(classifyQuotaState({ usage: 800, quota: 1000 })).toBe('low');
    expect(QUOTA_WARN_RATIO).toBe(0.8);
  });
  it('≥criticalRatio → critical', () => {
    expect(classifyQuotaState({ usage: 960, quota: 1000 })).toBe('critical');
    expect(QUOTA_CRITICAL_RATIO).toBe(0.95);
  });
  it('warn < ratio < critical → low，不提前升 critical', () => {
    expect(classifyQuotaState({ usage: 900, quota: 1000 })).toBe('low');
  });
});

describe('selectRecoveryActions 动作选择（host 能力门控）', () => {
  const webWithShare: RecoveryCapabilities = { isTauri: false, hasShare: true, fsaSupported: true };
  const webNoShare: RecoveryCapabilities = { isTauri: false, hasShare: false, fsaSupported: false };

  it('Tauri 桌面端 → 空数组（不弹浏览器引导，走原生保存对话框）', () => {
    expect(selectRecoveryActions({ isTauri: true, hasShare: true, fsaSupported: true })).toEqual([]);
    expect(selectRecoveryActions({ isTauri: true, hasShare: false, fsaSupported: false })).toEqual([]);
  });
  it('浏览器 PWA 恒有 export-file', () => {
    expect(hasAction(selectRecoveryActions(webWithShare), 'export-file')).toBe(true);
    expect(hasAction(selectRecoveryActions(webNoShare), 'export-file')).toBe(true);
  });
  it('有 Web Share（移动 Safari）→ 给 share，不给备份包下载', () => {
    const a = selectRecoveryActions(webWithShare);
    expect(a).toContain('share');
    expect(a).not.toContain('download-backup-pack');
  });
  it('无 Web Share（桌面 Safari/WebKit）→ 降级给 .kbpack 备份包下载，不给 share', () => {
    const a = selectRecoveryActions(webNoShare);
    expect(a).toContain('download-backup-pack');
    expect(a).not.toContain('share');
  });
  it('FSA 不支持（Safari/WebKit）不删减动作——host 层自动 anchor 下载兜底', () => {
    const a = selectRecoveryActions({ isTauri: false, hasShare: false, fsaSupported: false });
    expect(a).toHaveLength(2);
  });
});

describe('formatBytes 人类可读', () => {
  it('B / KB / MB / GB 换算', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
  it('非法值兜底为 —', () => {
    expect(formatBytes(NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });
});
