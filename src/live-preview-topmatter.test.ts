/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { indentUnit, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import {
  livePreview,
  orderedListBodyInsertFilter,
  topmatterHideField,
  topmatterSliceRange,
} from './live-preview';

let lastView: EditorView | null = null;

afterEach(() => {
  lastView?.destroy();
  lastView = null;
  document.body.replaceChildren();
});

function mkEditor(doc: string, anchor: number, head = anchor) {
  const state = EditorState.create({
    doc,
    selection: { anchor: Math.min(anchor, doc.length), head: Math.min(head, doc.length) },
    extensions: [
      orderedListBodyInsertFilter,
      indentUnit.of('\t'),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      livePreview,
      topmatterHideField,
    ],
  });
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state, parent });
  lastView = view;
  return view;
}

/** Each topmatter line’s text (excluding `\n`) has a collapsed replace; body is untouched. */
function topmatterLinesAreCollapsed(view: EditorView, tm: { from: number; to: number }): boolean {
  const set = view.state.field(topmatterHideField);
  const doc = view.state.doc;
  let pos = tm.from;
  while (pos < tm.to) {
    const line = doc.lineAt(pos);
    const from = Math.max(line.from, tm.from);
    const to = Math.min(line.to, tm.to);
    if (from < to) {
      let ok = false;
      set.between(from, to, (a, b, deco: Decoration) => {
        const spec = deco.spec as { widget?: unknown };
        if (spec.widget != null && a === from && b === to) ok = true;
      });
      if (!ok) return false;
    }
    pos = line.to + 1;
  }
  return true;
}

describe('topmatterSliceRange', () => {
  it('returns null without opening fence', () => {
    const doc = '# Title\n';
    const st = EditorState.create({ doc });
    expect(topmatterSliceRange(st.doc)).toBeNull();
  });

  it('returns null when closing fence is missing', () => {
    const doc = '---\nfoo: bar\n';
    const st = EditorState.create({ doc });
    expect(topmatterSliceRange(st.doc)).toBeNull();
  });

  it('parses closed block through newline after closing fence', () => {
    const doc = '---\nfoo: bar\n---\n# Title\n';
    const st = EditorState.create({ doc });
    const r = topmatterSliceRange(st.doc);
    expect(r).toEqual({ from: 0, to: doc.indexOf('# Title') });
  });
});

describe('live preview topmatter collapse', () => {
  const withMatter = '---\nfoo: bar\n---\n\n# Hello\n';

  it('collapses topmatter when caret is in body', () => {
    const cursor = withMatter.indexOf('Hello');
    const view = mkEditor(withMatter, cursor);
    const r = topmatterSliceRange(view.state.doc)!;
    expect(topmatterLinesAreCollapsed(view, r)).toBe(true);
  });

  it('shows raw topmatter when caret is inside it', () => {
    const cursor = withMatter.indexOf('foo');
    const view = mkEditor(withMatter, cursor);
    const r = topmatterSliceRange(view.state.doc)!;
    expect(topmatterLinesAreCollapsed(view, r)).toBe(false);
  });

  it('shows raw when selection spans body and topmatter', () => {
    const anchor = withMatter.indexOf('foo');
    const head = withMatter.indexOf('Hello');
    const view = mkEditor(withMatter, anchor, head);
    const r = topmatterSliceRange(view.state.doc)!;
    expect(topmatterLinesAreCollapsed(view, r)).toBe(false);
  });

  it('first # heading after YAML keeps live-preview H1 (regression: multi-line replace broke line decos)', () => {
    const doc = `---
mention: @AdamSmithKipnis
oneonone: true
triggers: onOpen => jonplummer.oneonone.hello
---
# Adam Smith-Kipnis, Sr UX Designer
See also @AdamSmithKipnis
`;
    const cursor = doc.indexOf('See also');
    const view = mkEditor(doc, cursor);
    const h1 = view.dom.querySelector('.cm-live-preview-h1');
    expect(h1).toBeTruthy();
    expect(h1!.textContent).toContain('Adam Smith-Kipnis');
  });
});
