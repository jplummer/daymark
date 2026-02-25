/**
 * Autocomplete sources for the CodeMirror editor.
 *
 * Wiki-link completion: typing `[[` triggers a ranked dropdown of notes
 * from the note index. Selecting an entry inserts `[[filename]]` where
 * filename is the on-disk name (minus .txt), which is what NotePlan uses
 * for link resolution.
 */

import { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { noteIndex } from './note-index';

const MAX_UNFILTERED = 50;

export function wikiLinkCompletion(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\[\[([^\]]*)$/);
  if (!match) return null;

  const query = match.text.slice(2);
  const from = match.from + 2;

  let results;
  if (query) {
    results = noteIndex.searchNotes(query);
  } else {
    results = noteIndex.entries
      .filter((e) => !e.isTrashed)
      .sort((a, b) => {
        if (a.isArchived && !b.isArchived) return 1;
        if (!a.isArchived && b.isArchived) return -1;
        return a.title.localeCompare(b.title);
      })
      .slice(0, MAX_UNFILTERED);
  }

  if (results.length === 0) return null;

  return {
    from,
    options: results.map((entry) => {
      const fileTitle = entry.filename.replace(/\.txt$/, '');
      const titleDiverged = entry.title !== fileTitle;
      return {
        label: entry.title,
        detail: titleDiverged
          ? fileTitle
          : entry.isArchived ? 'archived' : undefined,
        apply: `${fileTitle}]]`,
        type: 'text',
      };
    }),
    filter: false,
  };
}
