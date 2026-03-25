/**
 * Right-click context menu on task list lines: complete, cancel, schedule, reopen.
 * Scheduling uses NotePlan-style >today / >YYYY-MM-DD on the source and a daily copy with <back-ref.
 */

import { EditorView } from '@codemirror/view';
import { resolveEditorListLine, type ResolvedListLine, type TaskState } from './live-preview';
import {
  CALENDAR_WEEK_STARTS_ON,
  formatISODate,
  formatScheduleMenuDate,
  isoWeekRefForRowContaining,
  markdownScheduleDateTag,
  markdownScheduleWeekTag,
  nextIsoWeekRef,
  startOfDisplayWeek,
  thisIsoWeekRef,
  type ScheduleTarget,
} from './task-schedule';
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
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);
  x.setDate(x.getDate() + days);
  return x;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
  );
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

/** Single-line schedule row: label [hint] … monospace token (no wrap). */
function appendScheduleLine(
  menu: HTMLDivElement,
  label: string,
  token: string,
  hint: string | undefined,
  onPick: () => void,
) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'task-context-menu-item task-context-menu-item--schedule-line';
  const left = document.createElement('span');
  left.className = 'task-context-menu-schedule-line-left';
  const lab = document.createElement('span');
  lab.className = 'task-context-menu-schedule-label';
  lab.textContent = label;
  left.appendChild(lab);
  if (hint) {
    const h = document.createElement('span');
    h.className = 'task-context-menu-schedule-hint';
    h.textContent = hint;
    left.appendChild(h);
  }
  const tok = document.createElement('span');
  tok.className = 'task-context-menu-schedule-token';
  tok.textContent = token;
  btn.appendChild(left);
  btn.appendChild(tok);
  btn.addEventListener('click', () => {
    removeOpenMenu();
    onPick();
  });
  menu.appendChild(btn);
}

function appendScheduleCalendar(
  parent: HTMLElement,
  view: EditorView,
  lineNumber: number,
  compact: boolean,
) {
  const cal = document.createElement('div');
  cal.className = compact
    ? 'task-schedule-calendar task-schedule-calendar--compact'
    : 'task-schedule-calendar';

  const nav = document.createElement('div');
  nav.className = 'task-schedule-cal-nav';
  const body = document.createElement('div');
  body.className = 'task-schedule-cal-body';

  const now = new Date();
  const state = { y: now.getFullYear(), m: now.getMonth() };

  const paint = () => {
    nav.replaceChildren();
    body.replaceChildren();

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'task-schedule-cal-nav-btn';
    prev.setAttribute('aria-label', 'Previous month');
    prev.innerHTML = '<i class="ri-arrow-left-s-line" aria-hidden="true"></i>';
    prev.addEventListener('click', (e) => {
      e.stopPropagation();
      state.m -= 1;
      if (state.m < 0) {
        state.m = 11;
        state.y -= 1;
      }
      paint();
    });

    const title = document.createElement('span');
    title.className = 'task-schedule-cal-title';
    title.textContent = new Date(state.y, state.m, 1).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
    });

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'task-schedule-cal-nav-btn';
    next.setAttribute('aria-label', 'Next month');
    next.innerHTML = '<i class="ri-arrow-right-s-line" aria-hidden="true"></i>';
    next.addEventListener('click', (e) => {
      e.stopPropagation();
      state.m += 1;
      if (state.m > 11) {
        state.m = 0;
        state.y += 1;
      }
      paint();
    });

    nav.appendChild(prev);
    nav.appendChild(title);
    nav.appendChild(next);

    const weekStartsOn = CALENDAR_WEEK_STARTS_ON;
    const dowLabels =
      weekStartsOn === 'sunday'
        ? ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
        : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

    const dow = document.createElement('div');
    dow.className = 'task-schedule-cal-dow task-schedule-cal-dow--with-week';
    const wHead = document.createElement('span');
    wHead.className = 'task-schedule-cal-week-col-head';
    wHead.textContent = 'W';
    dow.appendChild(wHead);
    for (const label of dowLabels) {
      const c = document.createElement('span');
      c.textContent = label;
      dow.appendChild(c);
    }
    body.appendChild(dow);

    const grid = document.createElement('div');
    grid.className = 'task-schedule-cal-grid';

    const first = new Date(state.y, state.m, 1, 12, 0, 0);
    const lastDayNum = new Date(state.y, state.m + 1, 0, 12, 0, 0).getDate();
    const startPad =
      weekStartsOn === 'sunday' ? first.getDay() : (first.getDay() + 6) % 7;
    const totalCells = startPad + lastDayNum;
    const numRows = Math.ceil(totalCells / 7);
    const rowStartBase = startOfDisplayWeek(first, weekStartsOn);
    const today = new Date();

    for (let r = 0; r < numRows; r++) {
      const rowStart = addDaysLocal(rowStartBase, r * 7);
      const wk = isoWeekRefForRowContaining(rowStart, weekStartsOn);

      const rowGrid = document.createElement('div');
      rowGrid.className = 'task-schedule-cal-week-row';

      const wBtn = document.createElement('button');
      wBtn.type = 'button';
      wBtn.className = 'task-schedule-cal-week';
      wBtn.textContent = String(wk.week);
      wBtn.title = `${markdownScheduleWeekTag(wk.year, wk.week)} — weekly note`;
      wBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeOpenMenu();
        void applySchedule(view, lineNumber, { kind: 'week', year: wk.year, week: wk.week }).finally(
          () => view.focus(),
        );
      });
      rowGrid.appendChild(wBtn);

      for (let c = 0; c < 7; c++) {
        const idx = r * 7 + c;
        if (idx < startPad || idx >= startPad + lastDayNum) {
          const pad = document.createElement('span');
          pad.className = 'task-schedule-cal-pad';
          rowGrid.appendChild(pad);
        } else {
          const dayNum = idx - startPad + 1;
          const d = new Date(state.y, state.m, dayNum, 12, 0, 0);
          const iso = formatISODate(d);
          const token = markdownScheduleDateTag(d);
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'task-schedule-cal-day';
          b.textContent = String(dayNum);
          b.title = `${token} (ISO ${iso})`;
          if (isSameCalendarDay(d, today)) b.classList.add('task-schedule-cal-is-today');
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            removeOpenMenu();
            void applySchedule(view, lineNumber, { kind: 'date', date: d }).finally(() => view.focus());
          });
          rowGrid.appendChild(b);
        }
      }

      grid.appendChild(rowGrid);
    }

    body.appendChild(grid);
  };

  cal.appendChild(nav);
  cal.appendChild(body);
  paint();
  parent.appendChild(cal);
}

function appendScheduleSection(menu: HTMLDivElement, view: EditorView, lineNumber: number) {
  const divider = document.createElement('div');
  divider.className = 'task-context-menu-divider';
  menu.appendChild(divider);

  const heading = document.createElement('div');
  heading.className = 'task-context-menu-heading';
  heading.textContent = 'Schedule';
  menu.appendChild(heading);

  menu.classList.add('task-context-menu--with-schedule');

  appendScheduleLine(menu, 'Today', '>today', '(repeat until done)', () => {
    void applySchedule(view, lineNumber, { kind: 'today' }).finally(() => view.focus());
  });

  const tom = addDaysLocal(new Date(), 1);
  appendScheduleLine(
    menu,
    'Tomorrow',
    markdownScheduleDateTag(tom),
    `(${formatScheduleMenuDate(tom)})`,
    () => {
      void applySchedule(view, lineNumber, { kind: 'date', date: tom }).finally(() => view.focus());
    },
  );

  const tw = thisIsoWeekRef(new Date());
  appendScheduleLine(menu, 'This week', markdownScheduleWeekTag(tw.year, tw.week), undefined, () => {
    void applySchedule(view, lineNumber, { kind: 'week', year: tw.year, week: tw.week }).finally(() =>
      view.focus(),
    );
  });

  const nw = nextIsoWeekRef(new Date());
  appendScheduleLine(menu, 'Next week', markdownScheduleWeekTag(nw.year, nw.week), undefined, () => {
    void applySchedule(view, lineNumber, { kind: 'week', year: nw.year, week: nw.week }).finally(() =>
      view.focus(),
    );
  });

  const chooseWrap = document.createElement('div');
  chooseWrap.className = 'task-context-menu-choose-date';

  const chooseBtn = document.createElement('button');
  chooseBtn.type = 'button';
  chooseBtn.className =
    'task-context-menu-item task-context-menu-item--schedule-line task-context-menu-item--choose-date';
  const chooseLeft = document.createElement('span');
  chooseLeft.className = 'task-context-menu-schedule-line-left';
  const chooseLab = document.createElement('span');
  chooseLab.className = 'task-context-menu-schedule-label';
  chooseLab.textContent = 'Choose date';
  chooseLeft.appendChild(chooseLab);
  const calIcon = document.createElement('i');
  calIcon.className = 'ri-calendar-line task-context-menu-choose-date-icon';
  calIcon.setAttribute('aria-hidden', 'true');
  chooseBtn.appendChild(chooseLeft);
  chooseBtn.appendChild(calIcon);

  const calHost = document.createElement('div');
  calHost.className = 'task-context-menu-choose-date-cal';

  let calendarMounted = false;
  const ensureCalendar = () => {
    if (calendarMounted) return;
    calendarMounted = true;
    appendScheduleCalendar(calHost, view, lineNumber, true);
  };

  const revealCalendar = () => {
    ensureCalendar();
  };
  chooseWrap.addEventListener('mouseenter', revealCalendar);
  chooseWrap.addEventListener('focusin', revealCalendar);

  chooseWrap.appendChild(chooseBtn);
  chooseWrap.appendChild(calHost);
  menu.appendChild(chooseWrap);
}

let openMenuEl: HTMLDivElement | null = null;
let openMenuResizeObserver: ResizeObserver | null = null;

/** Close task line context menu if open (e.g. before opening another in-app menu). */
export function dismissTaskContextMenu(): void {
  removeOpenMenu();
}

function removeOpenMenu() {
  if (openMenuResizeObserver) {
    openMenuResizeObserver.disconnect();
    openMenuResizeObserver = null;
  }
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

/** Nudge a fixed menu so its full box stays inside the viewport (e.g. after calendar expands). */
function clampMenuIntoViewport(menu: HTMLElement): void {
  const pad = 8;
  const rect = menu.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  // One snapshot of geometry; clamp x/y like clampMenuPosition (avoids mixing stale rect edges after deltas).
  const left = Math.min(
    Math.max(pad, rect.left),
    Math.max(pad, window.innerWidth - w - pad),
  );
  const top = Math.min(
    Math.max(pad, rect.top),
    Math.max(pad, window.innerHeight - h - pad),
  );
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
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

  appendScheduleSection(menu, view, lineNumber);

  document.body.appendChild(menu);
  openMenuEl = menu;

  const rect = menu.getBoundingClientRect();
  const { left, top } = clampMenuPosition(clientX, clientY, rect.width, rect.height);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const scroller = view.scrollDOM;
  const onScrollerScroll = () => dismiss();

  const menuResizeObs = new ResizeObserver(() => {
    requestAnimationFrame(() => clampMenuIntoViewport(menu));
  });
  menuResizeObs.observe(menu);
  openMenuResizeObserver = menuResizeObs;

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
