/**
 * Right-click context menu on task list lines: complete, cancel, schedule, reopen.
 * Only offers actions that change the current task state.
 */

import { EditorView } from '@codemirror/view';
import { resolveEditorListLine, type ResolvedListLine, type TaskState } from './live-preview';

type TaskMenuAction = 'complete' | 'cancel' | 'schedule' | 'reopen';

const LABELS: Record<TaskMenuAction, string> = {
  complete: 'Complete task',
  cancel: 'Cancel task',
  schedule: 'Schedule task',
  reopen: 'Reopen task',
};

const CHECKLIST_LABELS: Record<TaskMenuAction, string> = {
  complete: 'Complete item',
  cancel: 'Cancel item',
  schedule: 'Schedule item',
  reopen: 'Reopen item',
};

function labelFor(resolved: ResolvedListLine, action: TaskMenuAction): string {
  return resolved.kind === 'checklist' ? CHECKLIST_LABELS[action] : LABELS[action];
}

function actionsForState(state: TaskState | undefined): TaskMenuAction[] {
  const s = state ?? 'open';
  const out: TaskMenuAction[] = [];
  if (s !== 'done') out.push('complete');
  if (s !== 'cancelled') out.push('cancel');
  if (s !== 'scheduled') out.push('schedule');
  if (s !== 'open') out.push('reopen');
  return out;
}

function changeForAction(
  resolved: ResolvedListLine,
  action: TaskMenuAction,
): { from: number; to: number; insert: string } | null {
  const { taskBoxFrom, taskBoxTo } = resolved;
  if (taskBoxFrom === undefined || taskBoxTo === undefined) return null;
  const box: Record<TaskMenuAction, string> = {
    complete: '[x]',
    cancel: '[-]',
    schedule: '[>]',
    reopen: '[ ]',
  };
  const next = box[action];
  if (taskBoxFrom === taskBoxTo) {
    return { from: taskBoxFrom, to: taskBoxTo, insert: `${next} ` };
  }
  return { from: taskBoxFrom, to: taskBoxTo, insert: next };
}

let openMenuEl: HTMLDivElement | null = null;

function removeOpenMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
}

function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
): { left: number; top: number } {
  const pad = 8;
  const maxLeft = window.innerWidth - menuWidth - pad;
  const maxTop = window.innerHeight - menuHeight - pad;
  return {
    left: Math.min(Math.max(pad, x), Math.max(pad, maxLeft)),
    top: Math.min(Math.max(pad, y), Math.max(pad, maxTop)),
  };
}

function showTaskContextMenu(
  clientX: number,
  clientY: number,
  view: EditorView,
  lineNumber: number,
  resolved: ResolvedListLine,
) {
  removeOpenMenu();

  const actions = actionsForState(resolved.taskState);
  if (actions.length === 0) return;

  const menu = document.createElement('div');
  menu.className = 'task-context-menu';
  menu.setAttribute('role', 'menu');

  for (const action of actions) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'task-context-menu-item';
    item.setAttribute('role', 'menuitem');
    item.textContent = labelFor(resolved, action);
    item.addEventListener('click', () => {
      removeOpenMenu();
      const fresh = resolveEditorListLine(view.state, lineNumber);
      if (!fresh || (fresh.kind !== 'task' && fresh.kind !== 'checklist')) return;
      const spec = changeForAction(fresh, action);
      if (!spec) return;
      view.dispatch({ changes: spec });
      view.focus();
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  openMenuEl = menu;

  const rect = menu.getBoundingClientRect();
  const { left, top } = clampMenuPosition(clientX, clientY, rect.width, rect.height);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const scroller = view.scrollDOM;
  const onScrollerScroll = () => dismiss();

  const dismiss = () => {
    removeOpenMenu();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', dismiss);
    scroller.removeEventListener('scroll', onScrollerScroll);
  };

  const onDocDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) dismiss();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
  };

  requestAnimationFrame(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', dismiss);
    scroller.addEventListener('scroll', onScrollerScroll);
  });
}

export const taskContextMenuHandler = EditorView.domEventHandlers({
  contextmenu(event: MouseEvent, view: EditorView) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) {
      removeOpenMenu();
      return false;
    }
    const line = view.state.doc.lineAt(pos);
    const resolved = resolveEditorListLine(view.state, line.number);
    if (!resolved || (resolved.kind !== 'task' && resolved.kind !== 'checklist')) {
      removeOpenMenu();
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    showTaskContextMenu(event.clientX, event.clientY, view, line.number, resolved);
    return true;
  },
});
