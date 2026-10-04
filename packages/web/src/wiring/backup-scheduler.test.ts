import { describe, it, expect, vi } from 'vitest';
import { createBackupScheduler } from './backup-scheduler';

/**
 * 时钟/动作全部注入，用手动队列模拟 interval。
 */
function setup() {
  let enabled = false;
  let dirty = false;
  const runBackup = vi.fn();
  const onBackupDone = vi.fn();
  const queue: { fn: () => void; ms: number }[] = [];
  const scheduler = createBackupScheduler(
    {
      isEnabled: () => enabled,
      isDirty: () => dirty,
      runBackup,
      onBackupDone,
      setInterval: (fn) => {
        queue.push({ fn, ms: 0 });
        return queue.length;
      },
      clearInterval: () => {},
    },
    10 * 60 * 1000,
  );
  const fire = () => queue.forEach((q) => q.fn());
  return { scheduler, runBackup, onBackupDone, set enabled(v: boolean) { enabled = v; }, set dirty(v: boolean) { dirty = v; }, fire };
}

describe('定时备份调度', () => {
  it('开启+dirty：到点触发一次备份并清 dirty', () => {
    const s = setup();
    s.scheduler.start();
    s.enabled = true;
    s.dirty = true;
    s.fire();
    expect(s.runBackup).toHaveBeenCalledTimes(1);
    expect(s.onBackupDone).toHaveBeenCalledTimes(1);
  });

  it('无 dirty：不触发', () => {
    const s = setup();
    s.scheduler.start();
    s.enabled = true;
    s.dirty = false;
    s.fire();
    expect(s.runBackup).not.toHaveBeenCalled();
  });

  it('关闭开关：即使 dirty 也不触发', () => {
    const s = setup();
    s.scheduler.start();
    s.enabled = false;
    s.dirty = true;
    s.fire();
    expect(s.runBackup).not.toHaveBeenCalled();
  });
});
