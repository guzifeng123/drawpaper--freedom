import { useEffect, useState } from 'react';

/**
 * useCoarsePointer —— 是否为粗指针（触屏/手写笔）设备。
 * 粗指针下画布显示显式工具按钮组（选择/连线/平移）作为手势歧义兜底。
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(pointer: coarse)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    const onChange = () => setCoarse(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return coarse;
}
