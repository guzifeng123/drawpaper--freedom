import * as React from 'react';
import { Cloud, Folder, Globe, Lock, RefreshCw, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { useSyncUi } from './sync-ui-store';
import { syncController, MIN_WEBDAV_POLL_MS } from './sync-controller';
import { pickRealDirectory, isFsaDirectorySupported } from './directory-handle';
import type { WebDavConfig } from './webdav';

/**
 * 设置 → 同步面板（Wave10 阶段 B；Wave11 加端到端加密）。
 * 零托管、零官方服务器：经用户自有「同步文件夹」或「WebDAV」在多设备间同步 .kbnote。
 * 两通道互斥：同时只配一个。未配置时零外网。
 *
 * Wave11 端到端加密（仅 WebDAV，默认关、用户主动开启）：
 *  - 开关 + 「记住本次会话」存 localStorage；口令不写 localStorage。
 *  - 刷新后若加密已开而口令未解锁，WebDAV 区弹解锁框，不发任何网络。
 */
const MIN_PASS_LEN = 8;

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

  // ---- Wave11 E2EE 本地态 ----
  const [e2eeOn, setE2eeOn] = React.useState(ui.e2eeEnabled);
  const [e2eePass, setE2eePass] = React.useState('');
  const [e2eeConfirm, setE2eeConfirm] = React.useState('');
  const [e2eeRemember, setE2eeRemember] = React.useState(false);
  const [e2eeError, setE2eeError] = React.useState('');
  const [unlockPass, setUnlockPass] = React.useState('');
  const [changingPass, setChangingPass] = React.useState(false);
  const [newPass, setNewPass] = React.useState('');
  const [newPassConfirm, setNewPassConfirm] = React.useState('');

  const isHttp = webdavUrl.startsWith('http://');

  const chooseFolder = async () => {
    const handle = await pickRealDirectory();
    if (!handle) return;
    syncController.startFolder(handle);
  };

  const saveWebdav = () => {
    const url = webdavUrl.trim().replace(/\/+$/, '');
    if (!url) return;
    if (e2eeOn) {
      if (e2eePass.length < MIN_PASS_LEN) {
        setE2eeError(`加密口令至少 ${MIN_PASS_LEN} 位`);
        return;
      }
      if (e2eePass !== e2eeConfirm) {
        setE2eeError('两次输入的加密口令不一致');
        return;
      }
    }
    setE2eeError('');
    const config: WebDavConfig = { baseUrl: url, username: webdavUser, password: webdavPass };
    syncController.startWebdav(config, pollOn ? MIN_WEBDAV_POLL_MS : 0, {
      enabled: e2eeOn,
      passphrase: e2eeOn ? e2eePass : undefined,
      rememberSession: e2eeRemember,
    });
  };

  const doUnlock = async () => {
    if (!unlockPass) return;
    try {
      await syncController.unlockWebdav(unlockPass);
      setUnlockPass('');
    } catch {
      /* 错误口令已由 controller toast；保留输入框供重试 */
    }
  };

  const doChangePass = async () => {
    if (newPass.length < MIN_PASS_LEN) {
      setE2eeError(`新口令至少 ${MIN_PASS_LEN} 位`);
      return;
    }
    if (newPass !== newPassConfirm) {
      setE2eeError('两次输入的新口令不一致');
      return;
    }
    setE2eeError('');
    try {
      await syncController.changeWebdavPassphrase(newPass, e2eeRemember);
      setChangingPass(false);
      setNewPass('');
      setNewPassConfirm('');
    } catch (e) {
      setE2eeError((e as Error).message);
    }
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

              {/* ---- Wave11 端到端加密 ---- */}
              <div className="flex items-center justify-between rounded border p-2">
                <div className="flex items-center gap-2">
                  <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                  <div className="flex flex-col">
                    <span className="text-xs font-medium">端到端加密</span>
                    <span className="text-[11px] text-muted-foreground">
                      开启后服务器只看到加密信封，无法读取文档标题与内容
                    </span>
                  </div>
                </div>
                <Switch
                  checked={e2eeOn}
                  onCheckedChange={(b) => {
                    setE2eeOn(b);
                    setE2eeError('');
                  }}
                  data-testid="e2ee-toggle"
                />
              </div>

              {e2eeOn && !ui.e2eeActive && !ui.e2eeLocked ? (
                <div className="flex flex-col gap-1.5 rounded border p-2" data-testid="e2ee-setup">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="e2ee-pass" className="text-xs">加密口令</Label>
                      <Input id="e2ee-pass" type="password" value={e2eePass} onChange={(e) => setE2eePass(e.target.value)} data-testid="e2ee-pass" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="e2ee-confirm" className="text-xs">确认口令</Label>
                      <Input id="e2ee-confirm" type="password" value={e2eeConfirm} onChange={(e) => setE2eeConfirm(e.target.value)} data-testid="e2ee-confirm" />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Checkbox checked={e2eeRemember} onCheckedChange={(v) => setE2eeRemember(v === true)} data-testid="e2ee-remember" />
                    记住本次会话（仅本标签页存活期间；关闭后每次刷新都需重输口令）
                  </label>
                </div>
              ) : null}

              {ui.e2eeLocked ? (
                <div className="flex flex-col gap-1.5 rounded border border-destructive/50 p-2" data-testid="e2ee-unlock-row">
                  <div className="text-xs text-destructive">端到端加密已开启：请输入口令解锁同步（不会把口令发给服务器）</div>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      placeholder="加密口令"
                      value={unlockPass}
                      onChange={(e) => setUnlockPass(e.target.value)}
                      data-testid="e2ee-unlock-pass"
                    />
                    <Button size="sm" onClick={() => void doUnlock()} data-testid="e2ee-unlock">
                      解锁并同步
                    </Button>
                  </div>
                </div>
              ) : null}

              {ui.e2eeActive ? (
                <div className="flex items-center justify-between rounded border bg-primary/5 p-2" data-testid="e2ee-active-row">
                  <span className="text-xs text-muted-foreground">端到端加密已启用（AES-256-GCM）</span>
                  <Button size="sm" variant="outline" onClick={() => setChangingPass(true)} data-testid="e2ee-change-pass">
                    更换口令
                  </Button>
                </div>
              ) : null}

              {changingPass ? (
                <div className="flex flex-col gap-1.5 rounded border p-2" data-testid="e2ee-change-row">
                  <div className="text-[11px] text-muted-foreground">
                    更换口令后，本端会把全部文档以新口令重新加密推送一份；旧设备需用新口令解锁。
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Input type="password" placeholder="新口令（≥8 位）" value={newPass} onChange={(e) => setNewPass(e.target.value)} data-testid="e2ee-new-pass" />
                    <Input type="password" placeholder="确认新口令" value={newPassConfirm} onChange={(e) => setNewPassConfirm(e.target.value)} data-testid="e2ee-new-confirm" />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void doChangePass()} data-testid="e2ee-change-confirm">确认更换并全量重推</Button>
                    <Button size="sm" variant="outline" onClick={() => setChangingPass(false)}>取消</Button>
                  </div>
                </div>
              ) : null}

              {e2eeError ? <div className="text-xs text-destructive" data-testid="e2ee-error">{e2eeError}</div> : null}

              <div className="flex gap-2">
                <Button size="sm" onClick={saveWebdav} data-testid="webdav-connect">
                  <Cloud className="h-4 w-4" /> 连接
                </Button>
                <Button size="sm" variant="outline" onClick={() => void syncController.runNow()} disabled={ui.busy || ui.e2eeLocked}>
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
