import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { indentUnit } from '@codemirror/language';
import {
  getOrderedMarkerEnd,
  getRenumberOrderedListChanges,
  getNextOrderedMarkerInRun,
  orderedListBodyInsertFilter,
  orderedListLineHasNoBody,
} from './live-preview';

/**
 * Integration tests for ordered-list body insert redirect and indent exceptions.
 * Uses EditorState + transactionFilter (no DOM / EditorView).
 */

function mkState(doc: string, indent = '\t') {
  return EditorState.create({
    doc,
    extensions: [orderedListBodyInsertFilter, indentUnit.of(indent)],
  });
}

describe('orderedListBodyInsertFilter', () => {
  it('redirects a multi-char insert at marker start to after the marker (no Four3) pattern)', () => {
    const base = mkState('2) Two');
    const tr = base.update({
      changes: { from: 0, to: 0, insert: 'Four' },
    });
    expect(tr.state.doc.toString()).toBe('2) FourTwo');
  });

  it('does not redirect a single digit insert at marker start (number edit)', () => {
    const base = mkState('2) Two');
    const tr = base.update({
      changes: { from: 0, to: 0, insert: '9' },
    });
    expect(tr.state.doc.toString()).toBe('92) Two');
  });

  it('allows Tab as exact indent unit at line start (markerFrom) without redirect', () => {
    const base = mkState('2) Two');
    const tr = base.update({
      changes: { from: 0, to: 0, insert: '\t' },
    });
    expect(tr.state.doc.toString()).toBe('\t2) Two');
  });

  it('allows insert when tagged input.indent even if insert is not the indent facet string', () => {
    const base = mkState('2) Two', '  ');
    const tr = base.update({
      changes: { from: 0, to: 0, insert: '\t' },
      userEvent: 'input.indent',
    });
    expect(tr.state.doc.toString()).toBe('\t2) Two');
  });
});

describe('getOrderedMarkerEnd / orderedListLineHasNoBody', () => {
  it('returns first body index after marker', () => {
    const state = EditorState.create({ doc: '12. Body here' });
    const end = getOrderedMarkerEnd(state, 1);
    expect(end).toBe(4);
    expect(state.doc.sliceString(end!, end! + 4)).toBe('Body');
  });

  it('orderedListLineHasNoBody is true only for marker-only lines', () => {
    expect(orderedListLineHasNoBody('3) ')).toBe(true);
    expect(orderedListLineHasNoBody('3) x')).toBe(false);
  });
});

describe('ordered list segments (nested restarts at 1)', () => {
  /** 4 spaces = indent level 1 in getIndentLevel */
  const sample = [
    '1) a',
    '2) b',
    '    2) c',
    '3) d',
    '    3) e',
    '4) f',
    '    4) g',
  ].join('\n');

  it('renumber makes each nested block 1), not continuing across top-level lines', () => {
    const state = EditorState.create({ doc: sample });
    const changes = getRenumberOrderedListChanges(state, 1);
    expect(changes.length).toBeGreaterThan(0);
    const tr = state.update({
      changes: changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
    });
    const t = tr.state.doc.toString();
    expect(t).toMatch(/^\s*1\) c/m);
    expect(t).toMatch(/^\s*1\) e/m);
    expect(t).toMatch(/^\s*1\) g/m);
  });

  it('getNextOrderedMarkerInRun uses segment: after top-level item, nested continues at 1)', () => {
    const state = EditorState.create({ doc: sample });
    const afterD = getNextOrderedMarkerInRun(state, 4);
    expect(afterD).toEqual({ num: 4, delim: ')' });
    const nestedAfterD = getNextOrderedMarkerInRun(state, 5);
    expect(nestedAfterD).toEqual({ num: 2, delim: ')' });
  });
});
