import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { EditorApi } from '../editor-api';
import { toast } from '../ui/toast';
import { getActiveBendAnchor, setActiveBendAnchor } from '../edges/bend-active';

/**
 * useKeyboardShortcuts —— 画布级快捷键（§4.6）。
 * 关键规则：
 * - 编辑中（editingNodeId 非空）：除 Esc 外所有画布快捷键屏蔽（Tiptap 自持）；
 *   中文输入法 composition 期间：屏蔽 Tab/Enter/方向键/空格。
 */
export function useKeyboardShortcuts(api: EditorApi): void {
  const rf = useReactFlow();

  useEffect(() => {
    let composing = false;
    const onCompStart = () => {
      composing = true;
    };
    const onCompEnd = () => {
      composing = false;
    };
    window.addEventListener('compositionstart', onCompStart);
    window.addEventListener('compositionend', onCompEnd);

    const onKey = (e: KeyboardEvent) => {
      const snap = api.getState();
      const editing = snap.editingNodeId !== null;
      const mod = e.metaKey || e.ctrlKey;

      // Esc 分层退出交给状态机（editing → 仍选中；select → 清空选择）。
      if (e.key === 'Escape') {
        if (editing) {
          e.preventDefault();
          api.setEditingNode(null);
        } else if (snap.selection.size > 0) {
          e.preventDefault();
          api.setSelection([]);
        }
        return;
      }

      // 合成期屏蔽编辑类键
      if (composing) return;

      if (editing) {
        // 块内编辑：画布键全部让路给 Tiptap
        return;
      }

      // ---- 修饰键组合 ----
      if (mod) {
        switch (e.key.toLowerCase()) {
          case 's':
            e.preventDefault();
            api.save();
            toast('已保存');
            return;
          case 'z':
            e.preventDefault();
            if (e.shiftKey) api.redo();
            else api.undo();
            return;
          case 'y':
            e.preventDefault();
            api.redo();
            return;
          case 'd':
            e.preventDefault();
            api.duplicate();
            return;
          case 'g': {
            e.preventDefault();
            // 成组：在选择包围盒左上角建一个 Group 视觉容器
            const ids = [...snap.selection];
            if (!ids.length) return;
            const nodes = snap.doc.nodes.filter((n) => ids.includes(n.id));
            const x = Math.min(...nodes.map((n) => n.x)) - 20;
            const y = Math.min(...nodes.map((n) => n.y)) - 36;
            api.addNode('group', x, y);
            api.setSelection(ids);
            return;
          }
          case 'f':
            e.preventDefault();
            api.openSearch();
            return;
          case 'p':
            e.preventDefault();
            api.openExport();
            return;
          case 'a': {
            e.preventDefault();
            api.setSelection(snap.doc.nodes.map((n) => n.id));
            return;
          }
          case '0':
            e.preventDefault();
            rf.fitView({ duration: 200 });
            return;
          case '1':
            e.preventDefault();
            rf.setViewport({ x: snap.viewport.x, y: snap.viewport.y, zoom: 1 }, { duration: 200 });
            return;
        }
        return;
      }

      // ---- 无修饰键 ----
      switch (e.key) {
        case 'Tab': {
          e.preventDefault();
          if (snap.selection.size !== 1) return;
          if (e.shiftKey) api.shiftTabDemote();
          else api.tabAddChild();
          return;
        }
        case 'Enter': {
          if (snap.selection.size === 1) {
            e.preventDefault();
            api.enterAddSibling();
          }
          return;
        }
        case 'Delete':
        case 'Backspace': {
          // 【P2.1】点中了某个弯折锚点 → 只删这一个锚点（不再清空全部弯折，也不删边/删块）。
          const anchor = getActiveBendAnchor();
          if (anchor) {
            e.preventDefault();
            e.stopPropagation();
            const edge = snap.doc.edges.find((ed) => ed.id === anchor.edgeId);
            const pts = edge?.points ?? [];
            if (edge && anchor.index >= 0 && anchor.index < pts.length) {
              api.setEdgePoints?.(edge.id, pts.filter((_, i) => i !== anchor.index));
            }
            setActiveBendAnchor(null);
            return;
          }
          if (snap.selection.size) {
            e.preventDefault();
            api.deleteNodes([...snap.selection]);
          }
          // 否则（仅边被选中）：不拦截，交给 RF 原生 deleteKeyCode 删边。
          return;
        }
        case 'F2': {
          if (snap.selection.size === 1) {
            e.preventDefault();
            api.setEditingNode([...snap.selection][0]!);
          }
          return;
        }
        case 'v':
          api.setMode('select');
          return;
        case 'c':
          api.setMode('connect');
          return;
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (!snap.selection.size) return;
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          for (const id of snap.selection) {
            const n = snap.doc.nodes.find((x) => x.id === id);
            if (n) api.moveNode(id, n.x + dx, n.y + dy);
          }
          return;
        }
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('compositionstart', onCompStart);
      window.removeEventListener('compositionend', onCompEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
}
