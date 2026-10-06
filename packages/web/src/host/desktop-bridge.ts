import { parseKBNote } from '@drawpaper/core';
import { TauriHostAdapter, TauriUnavailableError, type OpenFilePayload } from './tauri-host';
import { editorStore } from '@/store/editor-store';
import { getWiringUi } from '@/wiring/ui-store';
import { useThemeStore } from '@/panels/lib/theme';
import { pushToast } from '@/panels/lib/toast';
import { runExportAction } from '@/export/export-actions-bridge';

/**
 * Wave12 桌面桥：把 Rust 原生外壳（菜单 / 窗口标题 / 关闭守卫）接到前端 store。
 *
 * 浏览器环境（PWA / E2E）：`__TAURI__` 不存在 → 全部 no-op，零副作用。
 * 桌面 WebView2：构造一次 TauriHostAdapter，订阅 store 推标题/脏标记，
 * 监听 `app:menu` 分发动作，监听 `app:close-requested` 弹三选框。
 *
 * 菜单事件 id 清单（Rust → 前端）：
 *   file:new / file:open / file:save / file:save-as
 *   edit:undo / edit:redo           （cut/copy/paste/select-all 是 PredefinedMenuItem，WebView2 原生处理）
 *   export:print / export:pdf / export:png / export:svg / export:md
 *   view:dark-mode / view:outline / view:search
 *   sync:settings
 * （help:home / help:check-update / help:open-data-dir 由 Rust 直接 opener 处理，不经前端；
 *   file:open-recent / file:clear-recent 旧死分支已移除，并入动态「打开最近」子菜单，
 *   点击 recent:<n> 由 Rust 读盘后 emit 富 app:open-file，前端见 routeOpenFile。）
 */

/** 纯函数：窗口标题格式。导出供单测。
 *  脏=「● {文档名} — drawpaper」、干净=「{文档名} — drawpaper」、无文档=「drawpaper」。 */
export function computeWindowTitle(docTitle: string | null | undefined, dirty: boolean): string {
  if (!docTitle) return 'drawpaper';
  return dirty ? `● ${docTitle} — drawpaper` : `${docTitle} — drawpaper`;
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

let adapter: TauriHostAdapter | null = null;
let started = false;
/** file:open 成功后、loadDoc 触发 currentDocId 变更前暂存原生 path。 */
let pendingNativePath: string | null = null;

/** 菜单路由：原生菜单 id → store / UI 动作。未知 id 静默忽略。 */
async function routeMenu(id: string): Promise<void> {
  const s = editorStore.getState();
  switch (id) {
    case 'file:new':
      s.newDoc();
      break;
    case 'file:open': {
      const r = await adapter?.openKbnoteNative();
      if (!r) return;
      try {
        const { doc } = parseKBNote(r.text);
        pendingNativePath = r.path;
        s.loadDoc(doc);
        // loadDoc 是同步的，currentDocId 已变；这里立即绑定 + 兜底。
        await adapter?.bindNativeFile(r.path);
      } catch (err) {
        pushToast('error', `打开失败：${err instanceof Error ? err.message : '文件格式错误'}`);
      }
      break;
    }
    case 'file:save': {
      s.requestSave();
      try {
        await adapter?.showSaveFilePicker(
          `${s.doc.title || '未命名画布'}.kbnote`,
          s.exportKBNoteText(),
        );
        await adapter?.setNativeDirty(false);
      } catch {
        /* 用户取消保存对话框：保持原状 */
      }
      break;
    }
    case 'file:save-as': {
      try {
        await adapter?.saveKbnoteAs(
          `${s.doc.title || '未命名画布'}.kbnote`,
          s.exportKBNoteText(),
        );
        await adapter?.setNativeDirty(false);
      } catch {
        /* 取消 */
      }
      break;
    }
    case 'edit:undo':
      s.undo();
      break;
    case 'edit:redo':
      s.redo();
      break;
    case 'export:print':
    case 'export:pdf':
    case 'export:png':
    case 'export:svg':
    case 'export:md':
      runExportAction(id.slice('export:'.length) as 'print' | 'pdf' | 'png' | 'svg' | 'md');
      break;
    case 'view:dark-mode': {
      const theme = useThemeStore.getState();
      theme.setMode(theme.resolved === 'dark' ? 'light' : 'dark');
      break;
    }
    case 'view:outline':
      getWiringUi().setOutlineOpen(!getWiringUi().outlineOpen);
      break;
    case 'view:search':
      getWiringUi().setSearchOpen(true);
      break;
    case 'sync:settings':
      getWiringUi().setSyncOpen(true);
      break;
    default:
      /* help:check-update / help:open-data-dir / recent:* / view:fit / view:zoom-* 由 Rust 自取，前端不绑定 */
      break;
  }
}

/**
 * Wave13：最近文件菜单点击后 Rust 读盘 emit 的富 app:open-file。
 *  - text 存在（最近文件子菜单）：走与 file:open 成功分支相同的
 *    parseKBNote → loadDoc → bindNativeFile；文件缺失由 Rust 侧剔除，前端不 toast。
 *  - text 缺失（双击关联 / 单实例转发兼容路径）：webview 无任意路径读权限，
 *    按既有降级处理（不打开、不 toast）。
 */
async function routeOpenFile(payload: OpenFilePayload): Promise<void> {
  if (typeof payload.text !== 'string' || payload.text.length === 0) return;
  try {
    const { doc } = parseKBNote(payload.text);
    pendingNativePath = payload.path;
    editorStore.getState().loadDoc(doc);
    await adapter?.bindNativeFile(payload.path);
  } catch (err) {
    pushToast('error', `打开失败：${err instanceof Error ? err.message : '文件格式错误'}`);
  }
}

/**
 * App 挂载时调一次。浏览器环境直接返回 no-op 清理函数。
 * 重复调用幂等。
 */
export function initDesktopBridge(): () => void {
  if (started || !isTauriRuntime()) return () => undefined;
  let a: TauriHostAdapter;
  try {
    a = new TauriHostAdapter();
  } catch (err) {
    if (err instanceof TauriUnavailableError) return () => undefined;
    throw err;
  }
  adapter = a;
  started = true;

  // 标题 + 脏标记推送（doc.title / dirty / saveState 变化都重算一次）。
  const pushTitle = () => {
    const st = editorStore.getState();
    void a.setWindowTitle(computeWindowTitle(st.doc?.title, st.dirty));
    void a.setNativeDirty(st.dirty);
  };
  pushTitle();

  const unsubStore = editorStore.subscribe((state, prev) => {
    pushTitle();
    if (state.currentDocId !== prev.currentDocId) {
      if (pendingNativePath) {
        // 原生打开触发的文档切换：保持绑定（path 已在 file:open 里 bind 过）。
        pendingNativePath = null;
      } else {
        // 用户从文档列表/新建切到了别的文档 → 解绑原生文件（IDB 自动保存兜底）。
        void a.bindNativeFile(null);
      }
    }
  });

  let unlistenMenu: (() => void) | undefined;
  let unlistenClose: (() => void) | undefined;
  let unlistenOpenFile: (() => void) | undefined;
  void a.onMenuEvent((id) => void routeMenu(id)).then((u) => { unlistenMenu = u; });
  void a.onCloseRequested(() => {
    getWiringUi().setCloseGuardOpen(true);
  }).then((u) => { unlistenClose = u; });
  // Wave13：动态「打开最近」子菜单点击 → Rust 读盘后 emit 富 app:open-file。
  void a.onOpenFileEvent((p) => void routeOpenFile(p)).then((u) => { unlistenOpenFile = u; });

  return () => {
    unsubStore();
    unlistenMenu?.();
    unlistenClose?.();
    unlistenOpenFile?.();
    started = false;
    adapter = null;
  };
}

// ---------------------------------------------------------------------------
// 关闭守卫三选动作（CloseGuardDialog 调用）
// ---------------------------------------------------------------------------

/** 保存并退出：原地覆盖绑定的 .kbnote 后 force_quit；用户取消保存对话框则留在应用。 */
export async function closeGuardSaveAndQuit(): Promise<void> {
  const a = adapter;
  if (!a) return;
  const s = editorStore.getState();
  try {
    await a.showSaveFilePicker(`${s.doc.title || '未命名画布'}.kbnote`, s.exportKBNoteText());
  } catch {
    // 用户取消保存对话框 = 放弃这次退出，关掉守卫弹窗留在应用。
    getWiringUi().setCloseGuardOpen(false);
    return;
  }
  getWiringUi().setCloseGuardOpen(false);
  await a.forceQuit();
}

/** 不保存直接退出。 */
export async function closeGuardDiscardAndQuit(): Promise<void> {
  getWiringUi().setCloseGuardOpen(false);
  await adapter?.forceQuit();
}

/** 取消：什么都不做（不关窗）。 */
export function closeGuardCancel(): void {
  getWiringUi().setCloseGuardOpen(false);
}
