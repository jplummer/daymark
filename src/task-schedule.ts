/**
 * NotePlan-style task scheduling: source line `- [>] body >YYYY-MM-DD` or `>today`,
 * destination daily line `- [ ] body <YYYY-MM-DD>` (non-synced copy).
 */

import type { ResolvedListLine } from './live-preview';

export type ScheduleTarget = { kind: 'today' } | { kind: 'date'; date: Date };

export function formatISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Remove trailing >today, >YYYY-MM-DD, or <YYYY-MM-DD from task body text. */
export function stripTrailingScheduleTokens(body: string): string {
  let s = body.trimEnd();
  for (let i = 0; i < 4; i++) {
    const next = s
      .replace(/\s+<\d{4}-\d{2}-\d{2}\s*$/i, '')
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
  const tag = target.kind === 'today' ? '>today' : `>${formatISODate(target.date)}`;
  const middle = body.length > 0 ? `${bullet}[>] ${body} ${tag}` : `${bullet}[>] ${tag}`;
  return `${lead}${middle}`.trimEnd();
}

/** Line appended to the target daily note (non-synced scheduled copy). */
export function buildDestinationLine(taskBody: string, sourceBackRefISO: string): string {
  const b = stripTrailingScheduleTokens(taskBody).trim();
  return `- [ ] ${b} <${sourceBackRefISO}`;
}
