import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn/ui 约定的 className 合并工具。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
