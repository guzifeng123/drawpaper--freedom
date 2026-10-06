import { nanoid } from 'nanoid';

/**
 * 跨设备同步的本端设备身份（Wave10 阶段 B）。
 *
 * - clientId 持久化在 localStorage（与 AI key 同级，不上报、不外传）；
 *   同一浏览器/Profile 跨刷新稳定，不同设备（不同 BrowserContext / 浏览器）天然不同。
 * - 与 Wave9 多标签协作的 sessionStorage clientId（`c_…`）刻意区分：
 *   协作是「同浏览器多标签」，同步是「跨设备」，二者在 vv 里按 key 隔离、互不干扰。
 * - 零网络：只读 localStorage，无任何 fetch。
 */

const CLIENT_ID_KEY = 'drawpaper-sync:deviceClientId';

/** 本设备同步 clientId（`d_…`）。缺失则生成并持久化。 */
export function loadOrCreateDeviceClientId(): string {
  try {
    const raw = localStorage.getItem(CLIENT_ID_KEY);
    if (raw && raw.startsWith('d_')) return raw;
  } catch {
    /* localStorage 不可用（隐私模式 / 测试）：本次会话新建 */
  }
  const id = `d_${nanoid(12)}`;
  try {
    localStorage.setItem(CLIENT_ID_KEY, id);
  } catch {
    /* 持久化失败不影响当前会话 */
  }
  return id;
}

/** 测试/重置用：清除本设备 clientId（下次加载重新生成）。 */
export function resetDeviceClientIdForTest(): void {
  try {
    localStorage.removeItem(CLIENT_ID_KEY);
  } catch {
    /* ignore */
  }
}
