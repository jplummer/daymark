/**
 * Autocomplete sources for the CodeMirror editor.
 *
 * Wiki-link completion: typing `[[` triggers a ranked dropdown of notes
 * from the note index. Selecting an entry inserts `[[filename]]` where
 * filename is the on-disk name (minus .txt), which is what NotePlan uses
 * for link resolution.
 *
 * Mention completion: typing `@` triggers a ranked dropdown of known
 * @mentions. Ranked by frequency (active note count), `_`-prefixed last.
 *
 * Hashtag completion: typing `#` (after whitespace) triggers a ranked
 * dropdown of known #hashtags. Does not trigger at line start (headings).
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

export function mentionCompletion(context: CompletionContext): CompletionResult | null {
  // Match @<text> at a word boundary (start of line or after whitespace)
  const match = context.matchBefore(/(?:^|(?<=\s))@([A-Za-z_][A-Za-z0-9_/\-&]*)?$/);
  if (!match) return null;

  const query = match.text.startsWith('@') ? match.text.slice(1) : match.text.slice(match.text.indexOf('@') + 1);
  const from = match.from + (match.text.indexOf('@'));

  const ranked = noteIndex.getMentionsRanked();
  if (ranked.length === 0) return null;

  let filtered = ranked;
  if (query) {
    const q = query.toLowerCase();
    filtered = ranked.filter((r) => r.mention.toLowerCase().includes(q));
  } else {
    filtered = ranked.slice(0, MAX_UNFILTERED);
  }

  if (filtered.length === 0) return null;

  return {
    from,
    options: filtered.map((r) => ({
      label: r.mention,
      detail: r.count > 0 ? `${r.count} note${r.count === 1 ? '' : 's'}` : 'archived',
      type: 'text',
    })),
    filter: false,
  };
}

export function hashtagCompletion(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/(?:^|(?<=\s))#([A-Za-z][A-Za-z0-9_/\-&]*)?$/);
  if (!match) return null;

  const query = match.text.startsWith('#') ? match.text.slice(1) : match.text.slice(match.text.indexOf('#') + 1);
  const from = match.from + (match.text.indexOf('#'));

  const ranked = noteIndex.getHashtagsRanked();
  if (ranked.length === 0) return null;

  let filtered = ranked;
  if (query) {
    const q = query.toLowerCase();
    filtered = ranked.filter((r) => r.hashtag.toLowerCase().includes(q));
  } else {
    filtered = ranked.slice(0, MAX_UNFILTERED);
  }

  if (filtered.length === 0) return null;

  return {
    from,
    options: filtered.map((r) => ({
      label: r.hashtag,
      detail: r.count > 0 ? `${r.count} note${r.count === 1 ? '' : 's'}` : 'archived',
      type: 'text',
    })),
    filter: false,
  };
}
