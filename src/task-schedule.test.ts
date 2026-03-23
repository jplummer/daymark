import { describe, expect, it } from 'vitest';
import {
  buildDestinationLine,
  buildScheduledSourceLine,
  cleanedTaskBody,
  formatISODate,
  stripTrailingScheduleTokens,
} from './task-schedule';
import type { ResolvedListLine } from './live-preview';

describe('task-schedule', () => {
  it('strips trailing schedule tokens', () => {
    expect(stripTrailingScheduleTokens('Buy milk >today')).toBe('Buy milk');
    expect(stripTrailingScheduleTokens('x >2026-03-20')).toBe('x');
    expect(stripTrailingScheduleTokens('a <2026-01-01')).toBe('a');
  });

  it('builds source line with >today and concrete date', () => {
    const resolved: ResolvedListLine = {
      kind: 'task',
      taskState: 'open',
      markerFrom: 0,
      markerTo: 6,
      taskBoxFrom: 2,
      taskBoxTo: 5,
    };
    const line = '- [ ] hello';
    const lineFrom = 0;
    expect(buildScheduledSourceLine(line, lineFrom, resolved, { kind: 'today' })).toBe('- [>] hello >today');
    const d = new Date(2026, 2, 20);
    expect(buildScheduledSourceLine(line, lineFrom, resolved, { kind: 'date', date: d })).toBe(
      '- [>] hello >2026-03-20',
    );
  });

  it('builds checklist source line', () => {
    const resolved: ResolvedListLine = {
      kind: 'checklist',
      taskState: 'open',
      markerFrom: 0,
      markerTo: 6,
      taskBoxFrom: 2,
      taskBoxTo: 5,
    };
    expect(buildScheduledSourceLine('+ [ ] eggs', 0, resolved, { kind: 'today' })).toBe('+ [>] eggs >today');
  });

  it('builds destination line with back-ref', () => {
    expect(buildDestinationLine('hello', '2026-03-15')).toBe('- [ ] hello <2026-03-15');
  });

  it('formatISODate is stable', () => {
    expect(formatISODate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('cleanedTaskBody after marker', () => {
    const resolved: ResolvedListLine = {
      kind: 'task',
      taskState: 'scheduled',
      markerFrom: 0,
      markerTo: 6,
      taskBoxFrom: 2,
      taskBoxTo: 5,
    };
    expect(cleanedTaskBody('- [>] x >2026-01-01', 0, resolved)).toBe('x');
  });
});
