import { pushToast } from '@/panels/lib/toast';

/**
 * 轻提示 toast（editor 内部调用）。
 * Wave2 决策：toast() 直接委托给面板侧全局 toast（panels/lib/toast），
 * App 只挂一次 <Toaster/>。原 <ToastHost/> 已移除——画布内不再自渲染提示。
 * 用法：toast('自环禁止')；
 */
export function toast(message: string): void {
  pushToast('warn', message);
}
