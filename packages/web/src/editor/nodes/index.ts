import type { NodeTypes } from '@xyflow/react';
import type { BlockType } from '@drawpaper/core';
import {
  BulletBlock,
  GroupBlock,
  HeadingBlock,
  ImageBlock,
  NoteBlock,
  TextBlock,
  TodoBlock,
} from './blocks';

/** nodeTypes 模块级常量（禁止 render 内新建，保证 React Flow 稳定引用）。 */
export const nodeTypes: NodeTypes = {
  text: TextBlock,
  heading: HeadingBlock,
  todo: TodoBlock,
  bullet: BulletBlock,
  image: ImageBlock,
  note: NoteBlock,
  group: GroupBlock,
};

/** BlockType → nodeTypes key 的兜底（P1 类型回退为文本块）。 */
export function resolveNodeType(type: BlockType): string {
  return type in nodeTypes ? type : 'text';
}
