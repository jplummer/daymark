/**
 * Connects task context menu scheduling to main (Tauri FS + editor).
 */

import type { EditorView } from '@codemirror/view';
import type { ResolvedListLine } from './live-preview';
import type { ScheduleTarget } from './task-schedule';

export type TaskScheduleExecutor = (
  view: EditorView,
  lineNumber: number,
  resolved: ResolvedListLine,
  target: ScheduleTarget,
) => Promise<void>;

let executor: TaskScheduleExecutor | null = null;

export function registerTaskScheduleExecutor(fn: TaskScheduleExecutor | null): void {
  executor = fn;
}

export function runTaskSchedule(
  view: EditorView,
  lineNumber: number,
  resolved: ResolvedListLine,
  target: ScheduleTarget,
): Promise<void> {
  if (!executor) return Promise.resolve();
  return executor(view, lineNumber, resolved, target);
}
