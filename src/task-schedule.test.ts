import { describe, expect, it } from 'vitest';
import {
  buildDestinationLine,
  buildScheduledSourceLine,
  cleanedTaskBody,
  endOfISOWeekContaining,
  formatISODate,
  formatWeeklyCalendarFilename,
  isoWeekRefForRowContaining,
  markdownScheduleDateTag,
  markdownScheduleWeekTag,
  mondayOfNextISOWeek,
  nextIsoWeekRef,
  parseMarkdownISODateInput,
  startOfDisplayWeek,
  stripTrailingScheduleTokens,
  thisIsoWeekRef,
} from './task-schedule';
import type { ResolvedListLine } from './live-preview';

describe('task-schedule', () => {
  it('strips trailing schedule tokens', () => {
    expect(stripTrailingScheduleTokens('Buy milk >today')).toBe('Buy milk');
    expect(stripTrailingScheduleTokens('x >2026-03-20')).toBe('x');
    expect(stripTrailingScheduleTokens('a <2026-01-01')).toBe('a');
    expect(stripTrailingScheduleTokens('task >2026-W12')).toBe('task');
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
    expect(buildScheduledSourceLine(line, lineFrom, resolved, { kind: 'week', year: 2026, week: 12 })).toBe(
      '- [>] hello >2026-W12',
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

  it('markdownScheduleDateTag', () => {
    expect(markdownScheduleDateTag(new Date(2026, 2, 5))).toBe('>2026-03-05');
  });

  it('markdownScheduleWeekTag and weekly filename', () => {
    expect(markdownScheduleWeekTag(2026, 12)).toBe('>2026-W12');
    expect(formatWeeklyCalendarFilename(2026, 3)).toBe('2026-W03.txt');
  });

  it('parseMarkdownISODateInput accepts optional > prefix', () => {
    expect(formatISODate(parseMarkdownISODateInput('>2026-04-01')!)).toBe('2026-04-01');
    expect(formatISODate(parseMarkdownISODateInput('2026-04-01')!)).toBe('2026-04-01');
    expect(parseMarkdownISODateInput('not-a-date')).toBeNull();
  });

  it('ISO week: end Sunday and next Monday', () => {
    const wed = new Date(2025, 0, 8, 12, 0, 0);
    expect(formatISODate(endOfISOWeekContaining(wed))).toBe('2025-01-12');
    expect(formatISODate(mondayOfNextISOWeek(wed))).toBe('2025-01-13');
  });

  it('thisIsoWeekRef and nextIsoWeekRef roll year at year boundary', () => {
    const dec29 = new Date(2025, 11, 29, 12, 0, 0);
    expect(thisIsoWeekRef(dec29)).toEqual({ year: 2026, week: 1 });
    expect(nextIsoWeekRef(dec29)).toEqual({ year: 2026, week: 2 });
  });

  it('isoWeekRefForRowContaining uses Thursday in row', () => {
    const sun = new Date(2026, 2, 1, 12, 0, 0);
    const rowStart = startOfDisplayWeek(sun, 'sunday');
    expect(isoWeekRefForRowContaining(rowStart, 'sunday')).toEqual({ year: 2026, week: 10 });
  });
});
