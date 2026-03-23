/**
 * List / heading Tab, Shift-Tab, Enter, and Backspace handlers extracted for reuse and testing.
 * Wired from main.ts via listLineKeymapExtensions().
 */

import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';
import {
  isListLine,
  renumberOrderedListAfterIndent,
  getOrderedMarkerEnd,
  getNextOrderedMarkerInRun,
  ORDERED_LIST_REGEX,
} from './live-preview';

// When cursor is at end of a line that is only a start-of-line marker (task, bullet, ordered, checklist, or blockquote),
// Backspace clears the whole line to empty.
const TASK_MARKER_ONLY = /^\s*[-+] \[[x\-> ]\]\s*$/;
const BULLET_DASH_PLUS_ONLY = /^\s*[-+]\s*$/;
const BULLET_ASTERISK_ONLY = /^\s*\*\s*$/;
const BLOCKQUOTE_ONLY = /^\s*>\s*$/;
const ORDERED_LIST_ONLY = /^\s*\d+[.)]\s*$/;

/** Heading line: optional leading whitespace, then 1–6 #, then space (ATX heading). */
const HEADING_LINE = /^\s*#{1,6}\s/;

export function backspaceMarkerLineAware(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  if (!state.selection.main.empty || pos !== line.to) return false;
  const text = line.text;
  const isMarkerOnly =
    TASK_MARKER_ONLY.test(text) ||
    BULLET_DASH_PLUS_ONLY.test(text) ||
    BULLET_ASTERISK_ONLY.test(text) ||
    BLOCKQUOTE_ONLY.test(text) ||
    ORDERED_LIST_ONLY.test(text);
  if (!isMarkerOnly) return false;
  view.dispatch({ changes: { from: line.from, to: line.to } });
  return true;
}

/** Tab on a heading or list line inserts indent at line start (so it works when markers are hidden or replaced). */
export function tabOnHeadingOrListLine(view: EditorView): boolean {
  const { state } = view;
  if (!state.selection.main.empty) return false;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const lineNumber = line.number;
  const isHeading = HEADING_LINE.test(line.text);
  const isList = isListLine(state, lineNumber);
  if (!isHeading && !isList) return false;
  const unit = state.facet(indentUnit);
  const isOrdered = ORDERED_LIST_REGEX.test(line.text);
  view.dispatch({
    changes: { from: line.from, to: line.from, insert: unit },
    selection: { anchor: line.from + unit.length },
    userEvent: 'input.indent',
  });
  if (isOrdered) {
    renumberOrderedListAfterIndent(view, lineNumber);
    const afterMarker = getOrderedMarkerEnd(view.state, lineNumber);
    if (afterMarker !== null) view.dispatch({ selection: { anchor: afterMarker } });
  }
  return true;
}

/** Shift-Tab on a heading or list line removes one indent unit at line start, then renumbers ordered list if applicable. */
export function shiftTabOnHeadingOrListLine(view: EditorView): boolean {
  const { state } = view;
  if (!state.selection.main.empty) return false;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const lineNumber = line.number;
  const isHeading = HEADING_LINE.test(line.text);
  const isList = isListLine(state, lineNumber);
  if (!isHeading && !isList) return false;
  const leadingMatch = line.text.match(/^(\s+)/);
  const leading = leadingMatch ? leadingMatch[1] : '';
  if (leading.length === 0) return false;
  const unit = state.facet(indentUnit);
  let removeLen = 0;
  if (unit === '\t' && leading.startsWith('\t')) {
    removeLen = 1;
  } else if (leading.length >= 4 && /^ {1,4}$/.test(leading.slice(0, 4))) {
    removeLen = Math.min(4, leading.length);
  } else if (leading.startsWith(unit)) {
    removeLen = unit.length;
  }
  if (removeLen === 0) return false;
  const isOrdered = ORDERED_LIST_REGEX.test(line.text);
  const outdent = { from: line.from, to: line.from + removeLen, insert: '' };
  // Two steps: one combined ChangeSet of outdent + renumber was corrupting the doc (CM flush/order).
  // Renumber uses view.state after outdent so from/to are correct.
  // Do not set selection on outdent: TransactionSpec.selection is in post-change coords; old head would be wrong.
  view.dispatch({ changes: outdent });
  if (isOrdered) {
    renumberOrderedListAfterIndent(view, lineNumber);
    const afterMarker = getOrderedMarkerEnd(view.state, lineNumber);
    // Replace decorations on the marker are atomic; selection can snap to the start of the replaced range.
    if (afterMarker !== null) view.dispatch({ selection: { anchor: afterMarker } });
  }
  return true;
}

function isMarkerOnlyLine(text: string): boolean {
  return (
    TASK_MARKER_ONLY.test(text) ||
    BULLET_DASH_PLUS_ONLY.test(text) ||
    BULLET_ASTERISK_ONLY.test(text) ||
    BLOCKQUOTE_ONLY.test(text) ||
    ORDERED_LIST_ONLY.test(text)
  );
}

/** Enter: if line is marker-only, clear it (remove marker, cursor stays). Else continue list/blockquote or insert newline. */
export function enterListAndBlockquoteAware(view: EditorView): boolean {
  const { state } = view;
  if (!state.selection.main.empty) return false;
  const line = state.doc.lineAt(state.selection.main.head);
  const text = line.text;
  const leadingMatch = text.match(/^(\s*)/);
  const leading = leadingMatch ? leadingMatch[1] : '';

  if (isMarkerOnlyLine(text)) {
    view.dispatch({ changes: { from: line.from, to: line.to }, selection: { anchor: line.from } });
    return true;
  }

  const trimmed = text.trimStart();
  let insert: string;
  let orderedContinuation = false;

  if (trimmed.startsWith('> ')) {
    insert = '\n' + leading + '> ';
  } else {
    const taskBulletMatch = text.match(/^(\s*)([-+] \[[x\->  ]\] |(\*) |([-+]) )/);
    const orderedMatch = text.match(ORDERED_LIST_REGEX);
    if (taskBulletMatch) {
      const marker = taskBulletMatch[2];
      if (marker === '* ') {
        insert = '\n' + leading + '* ';
      } else if (marker.startsWith('+ ')) {
        insert = '\n' + leading + '+ [ ] ';
      } else {
        insert = '\n' + leading + '- [ ] ';
      }
    } else if (orderedMatch) {
      orderedContinuation = true;
      const nextInRun = getNextOrderedMarkerInRun(state, line.number);
      const num = nextInRun?.num ?? parseInt(orderedMatch[2], 10) + 1;
      const delim = nextInRun?.delim ?? orderedMatch[3] ?? '.';
      insert = '\n' + leading + String(num) + delim + ' ';
    } else {
      insert = '\n';
    }
  }

  view.dispatch(state.replaceSelection(insert));
  if (orderedContinuation && ORDERED_LIST_REGEX.test(view.state.doc.lineAt(view.state.selection.main.head).text)) {
    const ln = view.state.doc.lineAt(view.state.selection.main.head).number;
    const afterMarker = getOrderedMarkerEnd(view.state, ln);
    if (afterMarker !== null) view.dispatch({ selection: { anchor: afterMarker } });
  }
  return true;
}

/** Tab / Shift-Tab / Enter / Backspace keymaps for list and heading lines (use with Prec.high / Prec.highest). */
export function listLineKeymapExtensions() {
  return [
    Prec.high(
      keymap.of([
        { key: 'Tab', run: tabOnHeadingOrListLine },
        { key: 'Shift-Tab', run: shiftTabOnHeadingOrListLine },
      ]),
    ),
    Prec.highest(
      keymap.of([
        { key: 'Enter', run: enterListAndBlockquoteAware },
        { key: 'Backspace', run: backspaceMarkerLineAware },
      ]),
    ),
  ];
}
