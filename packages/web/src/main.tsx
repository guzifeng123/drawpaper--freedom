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
