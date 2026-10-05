import { createRoot, type Root } from 'react-dom/client';
import { OverviewCanvas } from './OverviewCanvas';
import { DexieOverviewProvider } from './DexieOverviewProvider';

/**
 * DEV-only：把全局总览画布挂到一个全屏 fixed 容器，供 e2e/截图验证。
 * Wave7 正式挂载由 App/路由接管；本函数仅在 import.meta.env.DEV 下被 dev-hooks 调用。
 */
let mountedRoot: Root | null = null;

export function mountOverviewDev(): void {
  const containerId = 'dev-overview-root';
  let el = document.getElementById(containerId);
  if (!el) {
    el = document.createElement('div');
    el.id = containerId;
    el.style.position = 'fixed';
    el.style.inset = '0';
    el.style.zIndex = '9999';
    el.style.background = '#fff';
    document.body.appendChild(el);
  }
  mountedRoot?.unmount();
  const root = createRoot(el);
  mountedRoot = root;
  root.render(
    <OverviewCanvas
      provider={new DexieOverviewProvider()}
      onOpenDocNode={(docId, nodeId) => {
        // e2e 断言口：记录最后一次 openDocNode 调用。
        ;(window as unknown as { __lastOpenDocNode?: [string, string] }).__lastOpenDocNode = [
          docId,
          nodeId,
        ];
      }}
    />,
  );
}

export function unmountOverviewDev(): void {
  mountedRoot?.unmount();
  mountedRoot = null;
  document.getElementById('dev-overview-root')?.remove();
}
