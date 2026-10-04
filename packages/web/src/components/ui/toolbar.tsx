import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * 工具栏容器：普通 div + cva（无 Radix 依赖）。
 * 提供一组横向分组按钮的统一样式容器。
 */
const toolbarVariants = cva('flex items-center gap-1', {
  variants: {
    size: {
      sm: 'h-8',
      default: 'h-9',
    },
  },
  defaultVariants: { size: 'default' },
});

export interface ToolbarProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof toolbarVariants> {}

export function Toolbar({ className, size, ...props }: ToolbarProps) {
  return <div role="toolbar" className={cn(toolbarVariants({ size }), className)} {...props} />;
}

/** 工具栏内的分隔小竖线。 */
export function ToolbarSeparator({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('mx-1 h-5 w-px bg-border', className)} {...props} />;
}
