/**
 * NotePlan-style task scheduling: source line `- [>] body >YYYY-MM-DD`, `>today`, or `>YYYY-Www`,
 * destination daily/weekly line `- [ ] body <YYYY-MM-DD>` (non-synced copy).
 */

import type { ResolvedListLine } from './live-preview';

/**
 * First day of the week shown in the schedule calendar grid.
 * **Not persisted yet** — add a Settings toggle (see PLAN.md).
 * `sunday` matches typical US calendars; `monday` matches ISO week rows.
 */
export const CALENDAR_WEEK_STARTS_ON: 'sunday' | 'monday' = 'sunday';

export type ScheduleTarget =
  | { kind: 'today' }
  | { kind: 'date'; date: Date }
  | { kind: 'week'; year: number; week: number };

export function formatISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Markdown token appended after task text for a calendar date (NotePlan scheduling). */
export function markdownScheduleDateTag(d: Date): string {
  return `>${formatISODate(d)}`;
}

/** Markdown token for a weekly note (`Calendar/YYYY-Www.txt`). */
export function markdownScheduleWeekTag(year: number, week: number): string {
  return `>${year}-W${String(week).padStart(2, '0')}`;
}

/** Filename for a weekly calendar note (same as NotePlan). */
export function formatWeeklyCalendarFilename(year: number, week: number): string {
  return `${year}-W${String(week).padStart(2, '0')}.txt`;
}

export function formatScheduleMenuDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function addDaysCalendar(d: Date, days: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);
  x.setDate(x.getDate() + days);
  return x;
}

/** ISO week number (Monday-based), same algorithm as main navigation. */
export function getSchedulingISOWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

export function mondayOfISOWeekNumber(year: number, week: number): Date {
  const jan4 = new Date(year, 0, 4, 12, 0, 0);
  const dayOfWeek = jan4.getDay() || 7;
  const mondayOfW1 = new Date(jan4);
  mondayOfW1.setDate(jan4.getDate() - dayOfWeek + 1);
  const target = new Date(mondayOfW1);
  target.setDate(mondayOfW1.getDate() + (week - 1) * 7);
  return target;
}

/** Sunday at the end of the ISO week that contains `d`. */
export function endOfISOWeekContaining(d: Date): Date {
  const { year, week } = getSchedulingISOWeek(d);
  const mon = mondayOfISOWeekNumber(year, week);
  return addDaysCalendar(mon, 6);
}

/** Monday at the start of the ISO week after the one containing `d`. */
export function mondayOfNextISOWeek(d: Date): Date {
  return addDaysCalendar(endOfISOWeekContaining(d), 1);
}

/** Start of the display week containing `d` (local calendar). */
export function startOfDisplayWeek(d: Date, start: 'sunday' | 'monday'): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);
  const dow = x.getDay();
  if (start === 'sunday') {
    return addDaysCalendar(x, -dow);
  }
  const offset = (dow + 6) % 7;
  return addDaysCalendar(x, -offset);
}

/**
 * ISO week year/week for the row that starts on `rowStart` (a Sunday or Monday).
 * Uses Thursday within that row (indices 4 or 3).
 */
export function isoWeekRefForRowContaining(
  rowStart: Date,
  weekStartsOn: 'sunday' | 'monday',
): { year: number; week: number } {
  const thursdayOffset = weekStartsOn === 'sunday' ? 4 : 3;
  const thu = addDaysCalendar(rowStart, thursdayOffset);
  return getSchedulingISOWeek(thu);
}

export function thisIsoWeekRef(d: Date = new Date()): { year: number; week: number } {
  return getSchedulingISOWeek(d);
}

export function nextIsoWeekRef(d: Date = new Date()): { year: number; week: number } {
  const { year, week } = getSchedulingISOWeek(d);
  const mon = mondayOfISOWeekNumber(year, week);
  const nextMon = addDaysCalendar(mon, 7);
  return getSchedulingISOWeek(nextMon);
}

/**
 * Parse a custom field: optional leading `>`, then strict YYYY-MM-DD.
 * Returns a local calendar date at noon, or null if invalid.
 */
export function parseMarkdownISODateInput(raw: string): Date | null {
  const t = raw.trim().replace(/^>\s*/, '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const [y, mo, day] = t.split('-').map(Number);
  const dt = new Date(y, mo - 1, day, 12, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== day) return null;
  return dt;
}

/** Remove trailing >today, >YYYY-MM-DD, >YYYY-Www, or <YYYY-MM-DD from task body text. */
export function stripTrailingScheduleTokens(body: string): string {
  let s = body.trimEnd();
  for (let i = 0; i < 6; i++) {
    const next = s
      .replace(/\s+<\d{4}-\d{2}-\d{2}\s*$/i, '')
      .replace(/\s+>\d{4}-W\d{2}\b\s*$/i, '')
      .replace(/\s+>\d{4}-\d{2}-\d{2}\s*$/i, '')
      .replace(/\s+>today\s*$/i, '')
      .trimEnd();
    if (next === s) break;
    s = next;
  }
  return s.trimEnd();
}

/**
 * Text after the list marker on this line (may include schedule tokens).
 * `lineText` must be the full line; `lineFrom` is the line's document offset.
 */
export function rawBodyAfterMarker(lineText: string, lineFrom: number, resolved: ResolvedListLine): string {
  const rel = resolved.markerTo - lineFrom;
  if (rel < 0 || rel > lineText.length) return '';
  return lineText.slice(rel);
}

export function cleanedTaskBody(lineText: string, lineFrom: number, resolved: ResolvedListLine): string {
  return stripTrailingScheduleTokens(rawBodyAfterMarker(lineText, lineFrom, resolved));
}

/** Full replacement line for the source note (task or checklist, always `[>]` when dated). */
export function buildScheduledSourceLine(
  lineText: string,
  lineFrom: number,
  resolved: ResolvedListLine,
  target: ScheduleTarget,
): string {
  const lead = lineText.match(/^(\s*)/)?.[1] ?? '';
  const body = cleanedTaskBody(lineText, lineFrom, resolved);
  const bullet = resolved.kind === 'checklist' ? '+ ' : '- ';
  let tag: string;
  if (target.kind === 'today') tag = '>today';
  else if (target.kind === 'date') tag = markdownScheduleDateTag(target.date);
  else tag = markdownScheduleWeekTag(target.year, target.week);
  const middle = body.length > 0 ? `${bullet}[>] ${body} ${tag}` : `${bullet}[>] ${tag}`;
  return `${lead}${middle}`.trimEnd();
}

/** Line appended to the target daily note (non-synced scheduled copy). */
export function buildDestinationLine(taskBody: string, sourceBackRefISO: string): string {
  const b = stripTrailingScheduleTokens(taskBody).trim();
  return `- [ ] ${b} <${sourceBackRefISO}`;
}
