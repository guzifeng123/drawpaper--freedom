import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import '@xyflow/react/dist/style.css';
import { installDevHooks } from './wiring/dev-hooks';
import { collabManager } from './collab/collab-manager';
import { syncController } from './sync/sync-controller';
import { reconcileAssetRefs } from './storage/asset-reconcile';
import { mark, timed } from './wiring/cold-starts';

// Wave24 路 3：冷启动分段埋点起点（timeOrigin 之后第一条应用侧 mark）。
mark('boot');

// DEV-only：挂载 window.__drawpaper__（生产构建被 tree-shake）。
installDevHooks();

// 同浏览器多标签实时协作（零服务器/零外网；不可用时单标签静默降级）。
collabManager.install();
mark('collab');

// Wave10 阶段 B：跨设备同步（零托管；未配置通道时零网络、零定时器）。
// Wave24：包进 timed() 落定后打 mark（fire-and-forget 不阻塞首屏）。
void timed('sync-restore', 'sync-restore-start', syncController.restore());

// Wave16 F：一次性把 v3 旧 nanoid 资产重命名为内容寻址 hash（幂等；坏档不阻断启动）。
// Wave24：延迟到首帧后的第一个 idle 再跑——实测它在 2k 块启动窗口内与主线程竞争
// （~2.8s 后台扫描产生多个 300ms+ 长任务），推迟不影响正确性（幂等迁移，无前置依赖）。
const wIdle = window as unknown as {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
};
const startReconcile = () => {
  void timed('asset-reconcile', 'asset-reconcile-start', reconcileAssetRefs());
};
if (typeof wIdle.requestIdleCallback === 'function') {
  wIdle.requestIdleCallback(startReconcile, { timeout: 3000 });
} else {
  setTimeout(startReconcile, 1500);
}

mark('render-start');
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
