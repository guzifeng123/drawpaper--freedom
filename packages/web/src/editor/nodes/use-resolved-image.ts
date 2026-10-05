import { useEffect, useState } from 'react';
import { getAssetUrl, isAssetRefSrc } from '@/storage/opfs';

/**
 * useResolvedImageSrc —— 把图片块的 image.src 解析成可直接塞进 <img> 的 URL。
 *
 * image.src 两种形状（Wave7 P2.1 起）：
 *  - assetRef id（OPFS 可用时）：经 getAssetUrl 取缓存的 objectURL（同一 ref 复用）；
 *  - data: / blob: URL（OPFS 不可用降级，或历史旧文档）：原样使用。
 *
 * 解析失败（引用丢失）返回空串，由调用方渲染占位，不抛错。
 */
export function useResolvedImageSrc(src: string | undefined | null): string {
  const [resolved, setResolved] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    if (!src) {
      setResolved('');
      return;
    }
    // 内联 data:/blob:/http 直接用。
    if (!isAssetRefSrc(src)) {
      setResolved(src);
      return;
    }
    // assetRef → OPFS objectURL（缓存）。
    void getAssetUrl(src).then((url) => {
      if (!cancelled) setResolved(url ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return resolved;
}
