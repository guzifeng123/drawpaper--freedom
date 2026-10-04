/**
 * 文档模板库（Wave3-H）。6 份内置模板的静态元数据。
 * 真实建文档由 api.createDocFromTemplate(templateId) 完成（存储 agent 实现初始块结构）。
 */

export interface DocTemplate {
  id: string;
  name: string;
  description: string;
  /** lucide 图标名（组件侧映射）。 */
  icon: 'book-open' | 'users' | 'graduation-cap' | 'lightbulb' | 'network' | 'puzzle';
}

export const DOC_TEMPLATES: readonly DocTemplate[] = [
  { id: 'reading', name: '读书笔记', description: '书籍章节 → 核心观点 → 摘录与心得的三层结构', icon: 'book-open' },
  { id: 'meeting', name: '会议纪要', description: '议题、结论、待办与人，按议程分支展开', icon: 'users' },
  { id: 'course', name: '课程大纲', description: '课程章节 → 知识点 → 练习与复习要点', icon: 'graduation-cap' },
  { id: 'brainstorm', name: '头脑风暴', description: '中心问题向外发散的自由想法树', icon: 'lightbulb' },
  { id: 'knowledge', name: '知识体系', description: '领域主干 → 概念网络 → 术语与例子', icon: 'network' },
  { id: 'project', name: '项目拆解', description: '目标 → 里程碑 → 任务 → 依赖与风险', icon: 'puzzle' },
] as const;
