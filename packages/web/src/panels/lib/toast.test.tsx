import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useToast, Toaster, __resetToasts } from './toast';

function Harness() {
  const toast = useToast();
  return (
    <div>
      <button onClick={() => toast.success('成功啦')}>ok</button>
      <button onClick={() => toast.error('出错了')}>err</button>
      <Toaster />
    </div>
  );
}

describe('toast', () => {
  beforeEach(() => __resetToasts());
  afterEach(() => {
    vi.useRealTimers();
  });

  it('自动消失', () => {
    vi.useFakeTimers();
    render(<Harness />);
    act(() => {
      screen.getByText('ok').click();
    });
    expect(screen.getByRole('status').textContent).toContain('成功啦');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('error 类型渲染', () => {
    render(<Harness />);
    act(() => {
      screen.getByText('err').click();
    });
    expect(screen.getByRole('status').textContent).toContain('出错了');
  });
});
