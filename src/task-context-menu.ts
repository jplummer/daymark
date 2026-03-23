/**
 * Right-click context menu on task list lines: complete, cancel, schedule, reopen.
 * Scheduling uses NotePlan-style >today / >YYYY-MM-DD on the source and a daily copy with <back-ref.
 */

import { EditorView } from '@codemirror/view';
import { resolveEditorListLine, type ResolvedListLine, type TaskState } from './live-preview';
import { formatISODate, type ScheduleTarget } from './task-schedule';
import { runTaskSchedule } from './task-schedule-bridge';

type TaskMenuAction = 'complete' | 'cancel' | 'reopen';

const LABELS: Record<TaskMenuAction, string> = {
  complete: 'Complete task',
  cancel: 'Cancel task',
  reopen: 'Reopen task',
};

const CHECKLIST_LABELS: Record<TaskMenuAction, string> = {
  complete: 'Complete item',
  cancel: 'Cancel item',
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
    reopen: '[ ]',
  };
  const next = box[action];
  if (taskBoxFrom === taskBoxTo) {
    return { from: taskBoxFrom, to: taskBoxTo, insert: `${next} ` };
  }
  return { from: taskBoxFrom, to: taskBoxTo, insert: next };
}

function addDaysLocal(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

async function applySchedule(
  view: EditorView,
  lineNumber: number,
  target: ScheduleTarget,
): Promise<void> {
  const fresh = resolveEditorListLine(view.state, lineNumber);
  if (!fresh || (fresh.kind !== 'task' && fresh.kind !== 'checklist')) return;
  await runTaskSchedule(view, lineNumber, fresh, target);
}

function appendScheduleSection(
  menu: HTMLDivElement,
  view: EditorView,
  lineNumber: number,
  resolved: ResolvedListLine,
) {
  const divider = document.createElement('div');
  divider.className = 'task-context-menu-divider';
  menu.appendChild(divider);

  const heading = document.createElement('div');
  heading.className = 'task-context-menu-heading';
  heading.textContent = resolved.kind === 'checklist' ? 'Schedule item' : 'Schedule task';
  menu.appendChild(heading);

  const todayBtn = document.createElement('button');
  todayBtn.type = 'button';
  todayBtn.className = 'task-context-menu-item';
  todayBtn.textContent = 'Today (>today)';
  todayBtn.addEventListener('click', () => {
    removeOpenMenu();
    void applySchedule(view, lineNumber, { kind: 'today' }).finally(() => view.focus());
  });
  menu.appendChild(todayBtn);

  const tom = addDaysLocal(new Date(), 1);
  const tomorrowBtn = document.createElement('button');
  tomorrowBtn.type = 'button';
  tomorrowBtn.className = 'task-context-menu-item';
  tomorrowBtn.textContent = `Tomorrow (${formatISODate(tom)})`;
  tomorrowBtn.addEventListener('click', () => {
    removeOpenMenu();
    void applySchedule(view, lineNumber, { kind: 'date', date: tom }).finally(() => view.focus());
  });
  menu.appendChild(tomorrowBtn);

  const row = document.createElement('div');
  row.className = 'task-context-menu-date-row';
  const inp = document.createElement('input');
  inp.type = 'date';
  inp.className = 'task-context-menu-date-input';
  inp.value = formatISODate(new Date());
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'task-context-menu-item task-context-menu-date-apply';
  apply.textContent = 'Schedule to date';
  apply.addEventListener('click', () => {
    if (!inp.value) return;
    removeOpenMenu();
    const parts = inp.value.split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return;
    const dt = new Date(parts[0], parts[1] - 1, parts[2]);
    void applySchedule(view, lineNumber, { kind: 'date', date: dt }).finally(() => view.focus());
  });
  row.appendChild(inp);
  row.appendChild(apply);
  menu.appendChild(row);
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

  const menu = document.createElement('div');
  menu.className = 'task-context-menu';
  menu.setAttribute('role', 'menu');

  const actions = actionsForState(resolved.taskState);
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

  appendScheduleSection(menu, view, lineNumber, resolved);

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
