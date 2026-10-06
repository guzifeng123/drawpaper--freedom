import * as React from 'react';
import { Cloud, Folder, Globe, RefreshCw, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useSyncUi } from './sync-ui-store';
import { syncController, MIN_WEBDAV_POLL_MS } from './sync-controller';
import { pickRealDirectory, isFsaDirectorySupported } from './directory-handle';
import type { WebDavConfig } from './webdav';

/**
 * 设置 → 同步面板（Wave10 阶段 B）。
 * 零托管、零官方服务器：经用户自有「同步文件夹」或「WebDAV」在多设备间同步 .kbnote。
 * 两通道互斥：同时只配一个。未配置时零外网。
 */
export function SyncSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ui = useSyncUi();
  const [webdavUrl, setWebdavUrl] = React.useState('');
  const [webdavUser, setWebdavUser] = React.useState('');
  const [webdavPass, setWebdavPass] = React.useState('');
  const [pollOn, setPollOn] = React.useState(false);

  const isHttp = webdavUrl.startsWith('http://');

  const chooseFolder = async () => {
    const handle = await pickRealDirectory();
    if (!handle) return;
    syncController.startFolder(handle);
  };

  const saveWebdav = () => {
    const url = webdavUrl.trim().replace(/\/+$/, '');
    if (!url) return;
    const config: WebDavConfig = { baseUrl: url, username: webdavUser, password: webdavPass };
    syncController.startWebdav(config, pollOn ? MIN_WEBDAV_POLL_MS : 0);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>同步</DialogTitle>
          <DialogDescription>
            跨设备同步 .kbnote，零托管、无官方服务器；数据只存在你选择的文件夹或 WebDAV。两通道互斥，同时只启用一个。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          {/* 状态行 */}
          <div className="grid grid-cols-3 gap-2 rounded border bg-muted/40 px-3 py-2 text-center text-xs">
            <div>
              <div className="text-muted-foreground">上次同步</div>
              <div data-testid="sync-last-at">
                {ui.lastSyncAt ? new Date(ui.lastSyncAt).toLocaleString() : '未同步'}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">推 / 拉</div>
              <div data-testid="sync-push-pull">
                {ui.pushCount} / {ui.pullCount}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">待解决冲突</div>
              <div data-testid="sync-conflict-count">{ui.conflictCount}</div>
            </div>
          </div>

          {/* 通道选择 */}
          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium text-muted-foreground">选择通道（互斥）</div>
            <label className="flex items-center gap-2 rounded border px-2 py-1.5" data-testid="channel-folder">
              <input
                type="radio"
                name="sync-channel"
                checked={ui.channel === 'folder'}
                onChange={() => syncController.startFolder}
                onClick={chooseFolder}
              />
              <Folder className="h-4 w-4" />
              同步文件夹
            </label>
            <label className="flex items-center gap-2 rounded border px-2 py-1.5" data-testid="channel-webdav">
              <input
                type="radio"
                name="sync-channel"
                checked={ui.channel === 'webdav'}
                onChange={() => ui.setChannel('webdav')}
              />
              <Globe className="h-4 w-4" />
              WebDAV
            </label>
          </div>

          {ui.channel === 'folder' ? (
            <div className="flex flex-col gap-2 rounded border p-3">
              <div className="text-xs text-muted-foreground">
                {ui.targetLabel || (isFsaDirectorySupported() ? '尚未选择目录' : '当前浏览器不支持目录选择，请用手动上传/下载降级')}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={chooseFolder} data-testid="pick-folder">
                  <Folder className="h-4 w-4" /> 选择同步目录
                </Button>
                <Button size="sm" variant="outline" onClick={() => void syncController.runNow()} disabled={ui.busy}>
                  <RefreshCw className="h-4 w-4" /> 立即同步
                </Button>
              </div>
            </div>
          ) : null}

          {ui.channel === 'webdav' ? (
            <div className="flex flex-col gap-2 rounded border p-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="webdav-url">服务器地址</Label>
                <Input
                  id="webdav-url"
                  placeholder="https://dav.example.com/drawpaper"
                  value={webdavUrl}
                  onChange={(e) => setWebdavUrl(e.target.value)}
                  data-testid="webdav-url"
                />
                {isHttp ? (
                  <div className="text-xs text-destructive" data-testid="http-warning">
                    警告：http 明文传输，凭据与文档不加密，仅建议本机/内网使用。
                  </div>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="webdav-user">用户名</Label>
                  <Input id="webdav-user" value={webdavUser} onChange={(e) => setWebdavUser(e.target.value)} data-testid="webdav-user" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="webdav-pass">密码</Label>
                  <Input id="webdav-pass" type="password" value={webdavPass} onChange={(e) => setWebdavPass(e.target.value)} data-testid="webdav-pass" />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="webdav-poll" className="text-xs text-muted-foreground">
                  定时轮询（下限 5 分钟，默认关）
                </Label>
                <Switch id="webdav-poll" checked={pollOn} onCheckedChange={setPollOn} />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={saveWebdav} data-testid="webdav-connect">
                  <Cloud className="h-4 w-4" /> 连接
                </Button>
                <Button size="sm" variant="outline" onClick={() => void syncController.runNow()} disabled={ui.busy}>
                  <RefreshCw className="h-4 w-4" /> 立即同步
                </Button>
              </div>
              {ui.error ? <div className="text-xs text-destructive" data-testid="webdav-error">{ui.error}</div> : null}
            </div>
          ) : null}

          {/* 停止同步 + 清除凭据 */}
          {ui.channel !== 'none' ? (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => void syncController.stopAndClear()}
              data-testid="stop-sync"
            >
              <Trash2 className="h-4 w-4" /> 停止同步并清除凭据
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
