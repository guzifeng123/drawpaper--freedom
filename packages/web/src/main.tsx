import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import '@xyflow/react/dist/style.css';
import { installDevHooks } from './wiring/dev-hooks';
import { collabManager } from './collab/collab-manager';
import { syncController } from './sync/sync-controller';
import { reconcileAssetRefs } from './storage/asset-reconcile';

// DEV-only：挂载 window.__drawpaper__（生产构建被 tree-shake）。
installDevHooks();

// 同浏览器多标签实时协作（零服务器/零外网；不可用时单标签静默降级）。
collabManager.install();

// Wave10 阶段 B：跨设备同步（零托管；未配置通道时零网络、零定时器）。
void syncController.restore();

// Wave16 F：一次性把 v3 旧 nanoid 资产重命名为内容寻址 hash（幂等；坏档不阻断启动）。
void reconcileAssetRefs();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Wave24 路1: tauri.conf 主窗口以 visible:false 启动（先不显示空白原生框）。
// React 挂载并完成一帧后，请外壳 reveal 已画好的窗口——消除白屏闪烁。
// 防御式：非 Tauri 环境 no-op；任何异常都吞掉（Rust setup 里另有 1.5s 安全网
// 兜底 show()，前端这招只是赢那个 race，早 reveal 而已）。
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = (window as any).__TAURI__;
  if (t && t.core && typeof t.core.invoke === 'function') {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void t.core.invoke('reveal_window').catch(() => undefined);
      }),
    );
  }
} catch {
  /* not running inside the Tauri WebView */
}
