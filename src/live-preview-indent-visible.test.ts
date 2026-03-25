/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { indentUnit, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { livePreview, orderedListBodyInsertFilter } from './live-preview';

let lastView: EditorView | null = null;

afterEach(() => {
  lastView?.destroy();
  lastView = null;
  document.body.replaceChildren();
});

function mkEditor(doc: string, cursor = doc.length) {
  const state = EditorState.create({
    doc,
    selection: { anchor: Math.min(cursor, doc.length) },
    extensions: [
      orderedListBodyInsertFilter,
      indentUnit.of('\t'),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      livePreview,
    ],
  });
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state, parent });
  lastView = view;
  return view;
}

/** True if some replace (widget) decoration lies entirely inside [line.from, line.from + leadLen). */
function hasReplaceDecorationInLeadingWhitespace(view: EditorView, lineNumber: number): boolean {
  const inst = view.plugin(livePreview);
  expect(inst).toBeTruthy();
  const line = view.state.doc.line(lineNumber);
  const m = line.text.match(/^(\s+)/);
  const leadLen = m ? m[1].length : 0;
  if (leadLen === 0) return false;
  const a = line.from;
  const b = line.from + leadLen;
  let found = false;
  inst!.decorations.between(a, b, (from, to, deco: Decoration) => {
    const spec = deco.spec as { widget?: unknown };
    if (spec.widget != null && from >= a && to <= b) found = true;
  });
  return found;
}

/**
 * Leading tabs/spaces stay in the document; live preview adds a low-contrast inline replace so
 * soft-wrapped rows share block padding (raw tabs alone only widen the first visual row).
 */
describe('leading indent layout (layout-preserving replace over leading whitespace)', () => {
  it('nested task line: leading tab has layout replace', () => {
    const view = mkEditor('\t- [ ] task', 0);
    expect(hasReplaceDecorationInLeadingWhitespace(view, 1)).toBe(true);
  });

  it('nested ordered list: leading tab has layout replace', () => {
    const view = mkEditor('\t99. item', 0);
    expect(hasReplaceDecorationInLeadingWhitespace(view, 1)).toBe(true);
  });

  it('tab-indented paragraph: layout replace over indent', () => {
    const view = mkEditor('\tplain body', 0);
    expect(hasReplaceDecorationInLeadingWhitespace(view, 1)).toBe(true);
  });

  it('heading with leading tab: layout replace over indent', () => {
    const view = mkEditor('\t## Title', 0);
    expect(hasReplaceDecorationInLeadingWhitespace(view, 1)).toBe(true);
  });

  it('blockquote with leading tab: layout replace over indent', () => {
    const view = mkEditor('\t> quote', 0);
    expect(hasReplaceDecorationInLeadingWhitespace(view, 1)).toBe(true);
  });

  it('double leading tab on bullet: layout replace covers both tabs', () => {
    const view = mkEditor('\t\t* item', 0);
    expect(hasReplaceDecorationInLeadingWhitespace(view, 1)).toBe(true);
  });
});
