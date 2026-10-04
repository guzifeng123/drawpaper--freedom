import {
  createDoc,
  createNode,
  createEdge,
  createTag,
  DEFAULT_NODE_SIZES,
} from '@drawpaper/core';
import type { BlockNode, KBNoteDoc } from '@drawpaper/core';

/**
 * 模板库：6 份开箱即用的 KBNoteDoc 工厂。
 * 每份产出「结构完整」的文档（根标题 + 若干块型 + 父子边 + 引导文字），
 * 内容为示例引导文字；id 全部由 core factory 全新生成，可直接落库。
 * web/src/store/editor-store.ts 把本注册表注入 deps.templates。
 */

/** 纯文本 → 合法 Tiptap doc（单段落）。 */
function para(text: string): unknown {
  return {
    type: 'doc',
    content: text
      ? [{ type: 'paragraph', content: [{ type: 'text', text }] }]
      : [{ type: 'paragraph' }],
  };
}

/** 块布局坐标步进（思维导图横向：根在左，子树向右）。 */
const CHILD_X = 320;
const SIBLING_GAP = 110;
const ROOT_X = 40;
const ROOT_Y = 60;

class DocBuilder {
  readonly doc: KBNoteDoc;
  private nodes: BlockNode[] = [];

  constructor(title: string) {
    this.doc = createDoc(title);
  }

  /** 新增块，返回其 id。 */
  add(type: BlockNode['type'], x: number, y: number, text: string, parentId?: string): string {
    const size = DEFAULT_NODE_SIZES[type] ?? DEFAULT_NODE_SIZES.text;
    const node = createNode(type, x, y, {
      content: { format: 'tiptap-json', data: para(text) },
      parentId: parentId ?? null,
    });
    node.width = size.width;
    node.height = size.height;
    this.nodes.push(node);
    return node.id;
  }

  /** 连父子边 parent→child。 */
  link(parentId: string, childId: string): void {
    this.doc.edges.push(createEdge(parentId, childId));
  }

  build(): KBNoteDoc {
    this.doc.nodes = this.nodes;
    return this.doc;
  }
}

/** 读书笔记。 */
function readingNotes(): KBNoteDoc {
  const b = new DocBuilder('《书名》读书笔记');
  const tag = createTag('读书笔记', '#7c3aed');
  b.doc.tags = [tag];
  const root = b.add('heading', ROOT_X, ROOT_Y, '《书名》读书笔记');
  const points = b.add('heading', CHILD_X, ROOT_Y, '核心观点', root);
  b.link(root, points);
  ['观点一：一句话概括', '观点二：作者的关键论据', '观点三：与既有认知的冲突'].forEach((t, i) => {
    const id = b.add('bullet', CHILD_X + 320, ROOT_Y + i * SIBLING_GAP, t, points);
    b.link(points, id);
  });
  const excerpt = b.add('note', CHILD_X, ROOT_Y + 3 * SIBLING_GAP, '摘录：在这里粘贴打动你的原文段落', root);
  b.link(root, excerpt);
  const think = b.add('text', CHILD_X, ROOT_Y + 4 * SIBLING_GAP, '我的思考：这本书改变了我哪个想法？', root);
  b.link(root, think);
  const todo = b.add('todo', CHILD_X, ROOT_Y + 5 * SIBLING_GAP, '行动清单：接下来要做的一件事', root);
  b.link(root, todo);
  return b.build();
}

/** 会议纪要。 */
function meetingNotes(): KBNoteDoc {
  const b = new DocBuilder('会议纪要 · 日期');
  b.doc.tags = [createTag('会议', '#0ea5e9')];
  const root = b.add('heading', ROOT_X, ROOT_Y, '会议主题');
  const who = b.add('text', CHILD_X, ROOT_Y, '参会人：', root);
  b.link(root, who);
  const goal = b.add('text', CHILD_X, ROOT_Y + SIBLING_GAP, '本次目标：要解决什么问题？', root);
  b.link(root, goal);
  const decisions = b.add('heading', CHILD_X, ROOT_Y + 2 * SIBLING_GAP, '决议事项', root);
  b.link(root, decisions);
  ['决议一', '决议二'].forEach((t, i) => {
    const id = b.add('todo', CHILD_X + 320, ROOT_Y + 2 * SIBLING_GAP + i * SIBLING_GAP, t, decisions);
    b.link(decisions, id);
  });
  const action = b.add('todo', CHILD_X, ROOT_Y + 4 * SIBLING_GAP, '待办：负责人 / 截止时间', root);
  b.link(root, action);
  const follow = b.add('text', CHILD_X, ROOT_Y + 5 * SIBLING_GAP, '下次跟进：时间与议题', root);
  b.link(root, follow);
  return b.build();
}

/** 课程大纲。 */
function courseOutline(): KBNoteDoc {
  const b = new DocBuilder('课程大纲');
  b.doc.tags = [createTag('课程', '#f59e0b')];
  const root = b.add('heading', ROOT_X, ROOT_Y, '课程名称');
  ['第一章', '第二章', '第三章'].forEach((chapter, ci) => {
    const cy = ROOT_Y + ci * 3 * SIBLING_GAP;
    const c = b.add('heading', CHILD_X, cy, chapter, root);
    b.link(root, c);
    ['小节 1', '小节 2', '小节 3'].forEach((lesson, li) => {
      const id = b.add('text', CHILD_X + 320, cy + li * SIBLING_GAP, `${chapter} · ${lesson}`, c);
      b.link(c, id);
    });
  });
  return b.build();
}

/** 头脑风暴。 */
function brainstorm(): KBNoteDoc {
  const b = new DocBuilder('头脑风暴 · 主题');
  b.doc.tags = [createTag('灵感', '#ec4899')];
  const root = b.add('heading', ROOT_X, ROOT_Y, '要解决的问题 / 主题');
  ['想法 A：先写下来，别评判', '想法 B：跨界联想', '想法 C：反过来想', '想法 D：最小可行版本'].forEach((t, i) => {
    const id = b.add('text', CHILD_X + (i % 2) * 320, ROOT_Y + i * SIBLING_GAP, t, root);
    b.link(root, id);
  });
  const note = b.add('note', CHILD_X, ROOT_Y + 4 * SIBLING_GAP, '后续：把最靠谱的想法转成项目拆解', root);
  b.link(root, note);
  return b.build();
}

/** 知识体系。 */
function knowledgeSystem(): KBNoteDoc {
  const b = new DocBuilder('知识体系');
  b.doc.tags = [createTag('知识管理', '#10b981')];
  const root = b.add('heading', ROOT_X, ROOT_Y, '我的知识域');
  ['概念分支一', '概念分支二'].forEach((branch, bi) => {
    const by = ROOT_Y + bi * 3 * SIBLING_GAP;
    const br = b.add('heading', CHILD_X, by, branch, root);
    b.link(root, br);
    ['核心定义', '关键模型', '应用场景'].forEach((leaf, li) => {
      const id = b.add('bullet', CHILD_X + 320, by + li * SIBLING_GAP, `${leaf}：待补充`, br);
      b.link(br, id);
    });
  });
  return b.build();
}

/** 项目拆解。 */
function projectBreakdown(): KBNoteDoc {
  const b = new DocBuilder('项目拆解');
  b.doc.tags = [createTag('项目', '#6366f1')];
  const root = b.add('heading', ROOT_X, ROOT_Y, '项目名称');
  ['阶段一 · 准备', '阶段二 · 执行', '阶段三 · 收尾'].forEach((phase, pi) => {
    const py = ROOT_Y + pi * 3 * SIBLING_GAP;
    const p = b.add('heading', CHILD_X, py, phase, root);
    b.link(root, p);
    ['任务 1', '任务 2'].forEach((task, ti) => {
      const id = b.add('todo', CHILD_X + 320, py + ti * SIBLING_GAP, `${task}：负责人 / 截止`, p);
      b.link(p, id);
    });
  });
  return b.build();
}

/** 模板注册表：templateId → 工厂。web 注入 deps.templates。 */
export const TEMPLATE_REGISTRY: Record<string, () => KBNoteDoc> = {
  'reading-notes': readingNotes,
  'meeting-notes': meetingNotes,
  'course-outline': courseOutline,
  brainstorm: brainstorm,
  'knowledge-system': knowledgeSystem,
  'project-breakdown': projectBreakdown,
};

/** 模板清单（UI 展示用）。 */
export const TEMPLATE_LIST = [
  { id: 'reading-notes', name: '读书笔记', icon: 'book' },
  { id: 'meeting-notes', name: '会议纪要', icon: 'users' },
  { id: 'course-outline', name: '课程大纲', icon: 'graduation-cap' },
  { id: 'brainstorm', name: '头脑风暴', icon: 'lightbulb' },
  { id: 'knowledge-system', name: '知识体系', icon: 'network' },
  { id: 'project-breakdown', name: '项目拆解', icon: 'flag' },
] as const;
