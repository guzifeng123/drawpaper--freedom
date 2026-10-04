import type { BlockNode, BlockType } from '@drawpaper/core';
import type { Node } from '@xyflow/react';

/** RF 自定义节点 data 契约。data.block 为核心真相（memo 比较引用）。 */
export interface BlockNodeData extends Record<string, unknown> {
  block: BlockNode;
}

export type AppNode = Node<BlockNodeData, BlockType>;
