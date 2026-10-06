import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWelcomeDoc,
  detectTauriHost,
  shouldCreateWelcomeDoc,
  WELCOME_DOC_ID,
  WELCOME_DOC_FLAG,
} from './welcome-doc';

/**
 * Wave13：欢迎文档创建条件纯函数 + 文档内容单测。
 *  - Tauri + 无标记 → 创建；有标记 → 不创建；浏览器宿主 → 永不创建。
 *  - 文档六项内容齐全、标题正确、id 确定。
 */

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI__;
  try {
    localStorage.removeItem(WELCOME_DOC_FLAG);
  } catch { /* 隐私模式忽略 */ }
});

describe('shouldCreateWelcomeDoc 创建条件', () => {
  it('Tauri 宿主 + 无标记 → 创建', () => {
    expect(shouldCreateWelcomeDoc({ isTauri: true, flagSet: false })).toBe(true);
  });
  it('Tauri 宿主 + 已有标记 → 不创建（防重复）', () => {
    expect(shouldCreateWelcomeDoc({ isTauri: true, flagSet: true })).toBe(false);
  });
  it('浏览器宿主（无 __TAURI__）→ 永不创建，无论标记', () => {
    expect(shouldCreateWelcomeDoc({ isTauri: false, flagSet: false })).toBe(false);
    expect(shouldCreateWelcomeDoc({ isTauri: false, flagSet: true })).toBe(false);
  });
});

describe('detectTauriHost', () => {
  it('无 __TAURI__ → false（浏览器/e2e）', () => {
    expect(detectTauriHost()).toBe(false);
  });
  it('有 __TAURI__ → true', () => {
    (window as unknown as Record<string, unknown>).__TAURI__ = { core: {} };
    expect(detectTauriHost()).toBe(true);
  });
});

describe('buildWelcomeDoc 内容清单', () => {
  const doc = buildWelcomeDoc();

  it('标题为「欢迎使用 drawpaper」且 id 确定', () => {
    expect(doc.title).toBe('欢迎使用 drawpaper');
    expect(doc.id).toBe(WELCOME_DOC_ID);
  });

  it('根块 + 六条说明块（共 7 个节点、6 条父子边）', () => {
    expect(doc.nodes).toHaveLength(7);
    expect(doc.edges).toHaveLength(6);
  });

  it('六项内容齐全（保存位置/双击打开/快捷键/同步/E2EE/SmartScreen/检查更新）', () => {
    const allText = doc.nodes.map((n) => JSON.stringify(n.content)).join('\n');
    expect(allText).toContain('IndexedDB');
    expect(allText).toContain('%APPDATA%');
    expect(allText).toContain('双击');
    expect(allText).toContain('Ctrl+Shift+S');
    expect(allText).toContain('Ctrl+P');
    expect(allText).toContain('WebDAV');
    expect(allText).toContain('SmartScreen');
    expect(allText).toContain('检查更新');
  });
});
