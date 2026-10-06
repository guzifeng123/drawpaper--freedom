import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import '@xyflow/react/dist/style.css';
import { installDevHooks } from './wiring/dev-hooks';
import { collabManager } from './collab/collab-manager';

// DEV-only：挂载 window.__drawpaper__（生产构建被 tree-shake）。
installDevHooks();

// 同浏览器多标签实时协作（零服务器/零外网；不可用时单标签静默降级）。
collabManager.install();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
