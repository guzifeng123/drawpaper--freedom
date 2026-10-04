import type { EdgeTypes } from '@xyflow/react';
import { ParentEdge } from './ParentEdge';

/** edgeTypes 模块级常量。P0 只有一种边：带箭头贝塞尔父子边。 */
export const edgeTypes: EdgeTypes = {
  parent: ParentEdge,
};
