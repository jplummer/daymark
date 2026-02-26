/**
 * Note index — scans the NotePlan notes directory to build an in-memory
 * lookup for link resolution, backlinks, mentions, and autocomplete.
 *
 * Link resolution follows NotePlan conventions:
 *   1. Primary: match by filename (minus .txt), case-insensitive
 *   2. Fallback: match by H1 title, case-insensitive
 *   3. Active notes win over archived/trashed duplicates
 */

import { readDir, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';

const NOTEPLAN_BASE = 'Library/Containers/co.noteplan.NotePlan-setapp/Data/Library/Application Support/co.noteplan.NotePlan-setapp';

// --- Types ---

export interface NoteEntry {
  filename: string;
  title: string;
  relPath: string;
  isArchived: boolean;
  isTrashed: boolean;
  outgoingLinks: string[];
  mentions: string[];
  hashtags: string[];
}

export interface BacklinkRef {
  entry: NoteEntry;
  context: string;
}

export interface SearchResult {
  entry: NoteEntry;
  lines: { lineNum: number; text: string; isDone: boolean }[];
}

// --- Parsing ---

function linkKey(filename: string): string {
  return filename.replace(/\.txt$/, '').toLowerCase();
}

const WIKILINK_RE = /\[\[(.+?)\]\]/g;
const MENTION_RE = /(?:^|(?<=\s))@([A-Za-z_][A-Za-z0-9_/\-&]*)/g;
const HASHTAG_RE = /(?:^|(?<=\s))#([A-Za-z][A-Za-z0-9_/\-&]*)/gm;

interface ParsedContent {
  title: string | null;
  outgoingLinks: string[];
  mentions: string[];
  hashtags: string[];
}

function parseNoteContent(text: string): ParsedContent {
  const titleMatch = text.match(/^\s*#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : null;

  const outgoingLinks: string[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const target = m[1].trim();
    if (target && !outgoingLinks.includes(target)) {
      outgoingLinks.push(target);
    }
  }

  const mentions: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const mention = `@${m[1]}`;
    if (!mentions.includes(mention)) {
      mentions.push(mention);
    }
  }

  const hashtags: string[] = [];
  for (const m of text.matchAll(HASHTAG_RE)) {
    const tag = `#${m[1]}`;
    if (!hashtags.includes(tag)) {
      hashtags.push(tag);
    }
  }

  return { title, outgoingLinks, mentions, hashtags };
}

// --- Index ---

export class NoteIndex {
  private _entries: NoteEntry[] = [];
  private _byLinkKey = new Map<string, NoteEntry[]>();
  private _byRelPath = new Map<string, NoteEntry>();
  // linkKey (lowercase) -> relPaths of notes that contain [[linkKey]] as outgoing link
  private _backlinkIndex = new Map<string, string[]>();

  get entries(): readonly NoteEntry[] {
    return this._entries;
  }

  async build(): Promise<void> {
    const notesPath = `${NOTEPLAN_BASE}/Notes`;
    const t0 = performance.now();
    this._entries = await this.scanDirectory(notesPath);
    this.rebuildMaps();
    console.log(`[daymark] Note index: ${this._entries.length} notes in ${Math.round(performance.now() - t0)}ms`);
  }

  private async scanDirectory(
    relDir: string,
    flags: { isArchived?: boolean; isTrashed?: boolean } = {},
  ): Promise<NoteEntry[]> {
    let dirEntries;
    try {
      dirEntries = await readDir(relDir, { baseDir: BaseDirectory.Home });
    } catch {
      return [];
    }

    const entries: NoteEntry[] = [];

    // Process files in parallel batches for speed
    const files: { name: string; path: string }[] = [];
    const subdirs: { name: string; path: string; flags: typeof flags }[] = [];

    for (const entry of dirEntries) {
      const childPath = `${relDir}/${entry.name}`;
      if (entry.isDirectory) {
        const childFlags = { ...flags };
        if (entry.name === '@Archive') childFlags.isArchived = true;
        if (entry.name === '@Trash') childFlags.isTrashed = true;
        subdirs.push({ name: entry.name, path: childPath, flags: childFlags });
      } else if (entry.name.endsWith('.txt')) {
        files.push({ name: entry.name, path: childPath });
      }
    }

    // Read all files in this directory concurrently
    const fileResults = await Promise.all(
      files.map(async (f) => {
        try {
          const text = await readTextFile(f.path, { baseDir: BaseDirectory.Home });
          const parsed = parseNoteContent(text);
          return {
            filename: f.name,
            title: parsed.title || f.name.replace(/\.txt$/, ''),
            relPath: f.path,
            isArchived: !!flags.isArchived,
            isTrashed: !!flags.isTrashed,
            outgoingLinks: parsed.outgoingLinks,
            mentions: parsed.mentions,
            hashtags: parsed.hashtags,
          } as NoteEntry;
        } catch {
          return null;
        }
      }),
    );

    for (const result of fileResults) {
      if (result) entries.push(result);
    }

    // Recurse into subdirectories concurrently
    const subdirResults = await Promise.all(
      subdirs.map((d) => this.scanDirectory(d.path, d.flags)),
    );
    for (const children of subdirResults) {
      entries.push(...children);
    }

    return entries;
  }

  private rebuildMaps() {
    this._byLinkKey.clear();
    this._byRelPath.clear();
    this._backlinkIndex.clear();

    for (const entry of this._entries) {
      this._byRelPath.set(entry.relPath, entry);

      const key = linkKey(entry.filename);
      let bucket = this._byLinkKey.get(key);
      if (!bucket) {
        bucket = [];
        this._byLinkKey.set(key, bucket);
      }
      bucket.push(entry);

      for (const link of entry.outgoingLinks) {
        const targetKey = link.toLowerCase();
        let refs = this._backlinkIndex.get(targetKey);
        if (!refs) {
          refs = [];
          this._backlinkIndex.set(targetKey, refs);
        }
        refs.push(entry.relPath);
      }
    }
  }

  /**
   * Resolve a [[wiki-link]] target to a note entry.
   *
   * Priority order:
   *   1. Active note matching by filename
   *   2. Active note matching by title
   *   3. Archived note matching by filename
   *   4. Archived note matching by title
   *   Trashed notes are never returned.
   */
  resolveLink(title: string): NoteEntry | null {
    const key = title.toLowerCase();

    const byFilename = this._byLinkKey.get(key) || [];
    const byTitle = this._entries.filter(
      (e) => e.title.toLowerCase() === key && !byFilename.includes(e),
    );

    // Active matches first (filename then title)
    for (const candidates of [byFilename, byTitle]) {
      const active = candidates.filter((e) => !e.isArchived && !e.isTrashed);
      if (active.length > 0) return active[0];
    }

    // Archived matches as fallback (never trashed)
    for (const candidates of [byFilename, byTitle]) {
      const archived = candidates.filter((e) => e.isArchived && !e.isTrashed);
      if (archived.length > 0) return archived[0];
    }

    return null;
  }

  /**
   * Find all notes that contain a [[link]] pointing to the given note.
   */
  getBacklinks(relPath: string): NoteEntry[] {
    const entry = this._byRelPath.get(relPath);
    if (!entry) return [];

    // Check both filename key and title key (they can diverge)
    const keys = new Set<string>();
    keys.add(linkKey(entry.filename));
    keys.add(entry.title.toLowerCase());

    const linkingPaths = new Set<string>();
    for (const key of keys) {
      for (const p of this._backlinkIndex.get(key) || []) {
        if (p !== relPath) linkingPaths.add(p);
      }
    }

    return [...linkingPaths]
      .map((p) => this._byRelPath.get(p)!)
      .filter(Boolean);
  }

  /**
   * Search notes by title/filename for autocomplete.
   * Excludes trashed notes. Active notes rank above archived.
   * Exact matches rank first, then prefix, then substring.
   */
  searchNotes(query: string): NoteEntry[] {
    if (!query) return [];
    const q = query.toLowerCase();

    return this._entries
      .filter((e) => !e.isTrashed)
      .filter((e) =>
        e.title.toLowerCase().includes(q)
        || linkKey(e.filename).includes(q),
      )
      .sort((a, b) => {
        const aTitle = a.title.toLowerCase();
        const bTitle = b.title.toLowerCase();
        const aKey = linkKey(a.filename);
        const bKey = linkKey(b.filename);

        // Exact match (title or filename)
        const aExact = aTitle === q || aKey === q;
        const bExact = bTitle === q || bKey === q;
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;

        // Prefix match
        const aPrefix = aTitle.startsWith(q) || aKey.startsWith(q);
        const bPrefix = bTitle.startsWith(q) || bKey.startsWith(q);
        if (aPrefix && !bPrefix) return -1;
        if (!aPrefix && bPrefix) return 1;

        // Active over archived
        if (a.isArchived && !b.isArchived) return 1;
        if (!a.isArchived && b.isArchived) return -1;

        return a.title.localeCompare(b.title);
      });
  }

  /** All unique @mentions across indexed notes. */
  getAllMentions(): string[] {
    const set = new Set<string>();
    for (const entry of this._entries) {
      for (const m of entry.mentions) set.add(m);
    }
    return [...set].sort();
  }

  /**
   * @mentions deduplicated case-insensitively, with canonical form (most frequent
   * casing) preserved. Counts only active (non-archived) notes. Archive-only
   * mentions are included with count 0.
   */
  getMentionsRanked(): { mention: string; count: number; archiveOnly: boolean }[] {
    // key = lowercase mention → { forms: Map<exactForm, activeCount>, totalActive }
    const agg = new Map<string, { forms: Map<string, number>; active: number; total: number }>();

    for (const entry of this._entries) {
      if (entry.isTrashed) continue;
      const seen = new Set<string>();
      for (const m of entry.mentions) {
        const key = m.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        let bucket = agg.get(key);
        if (!bucket) {
          bucket = { forms: new Map(), active: 0, total: 0 };
          agg.set(key, bucket);
        }
        bucket.total++;
        if (!entry.isArchived) {
          bucket.active++;
          bucket.forms.set(m, (bucket.forms.get(m) || 0) + 1);
        } else {
          // Track form even for archived so we have a canonical if archive-only
          if (!bucket.forms.has(m)) bucket.forms.set(m, 0);
        }
      }
    }

    return [...agg.values()].map((bucket) => {
      // Canonical form = most-frequent casing among active notes (or any if archive-only)
      let canonical = '';
      let bestCount = -1;
      for (const [form, cnt] of bucket.forms) {
        if (cnt > bestCount) { canonical = form; bestCount = cnt; }
      }
      return {
        mention: canonical,
        count: bucket.active,
        archiveOnly: bucket.active === 0,
      };
    }).sort((a, b) => {
      if (a.archiveOnly !== b.archiveOnly) return a.archiveOnly ? 1 : -1;
      return a.mention.localeCompare(b.mention, undefined, { sensitivity: 'base' });
    });
  }

  /** All unique #hashtags across indexed notes. */
  getAllHashtags(): string[] {
    const set = new Set<string>();
    for (const entry of this._entries) {
      for (const h of entry.hashtags) set.add(h);
    }
    return [...set].sort();
  }

  /**
   * #hashtags deduplicated case-insensitively, with canonical form preserved.
   * Same logic as getMentionsRanked() but without _-prefix grouping.
   */
  getHashtagsRanked(): { hashtag: string; count: number; archiveOnly: boolean }[] {
    const agg = new Map<string, { forms: Map<string, number>; active: number }>();

    for (const entry of this._entries) {
      if (entry.isTrashed) continue;
      const seen = new Set<string>();
      for (const h of entry.hashtags) {
        const key = h.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        let bucket = agg.get(key);
        if (!bucket) {
          bucket = { forms: new Map(), active: 0 };
          agg.set(key, bucket);
        }
        if (!entry.isArchived) {
          bucket.active++;
          bucket.forms.set(h, (bucket.forms.get(h) || 0) + 1);
        } else {
          if (!bucket.forms.has(h)) bucket.forms.set(h, 0);
        }
      }
    }

    return [...agg.values()].map((bucket) => {
      let canonical = '';
      let bestCount = -1;
      for (const [form, cnt] of bucket.forms) {
        if (cnt > bestCount) { canonical = form; bestCount = cnt; }
      }
      return {
        hashtag: canonical,
        count: bucket.active,
        archiveOnly: bucket.active === 0,
      };
    }).sort((a, b) => {
      if (a.archiveOnly !== b.archiveOnly) return a.archiveOnly ? 1 : -1;
      return a.hashtag.localeCompare(b.hashtag, undefined, { sensitivity: 'base' });
    });
  }

  /** Look up an entry by its relPath. */
  getEntry(relPath: string): NoteEntry | null {
    return this._byRelPath.get(relPath) || null;
  }

  /**
   * Update a single entry's content in-place (e.g. after saving).
   * Re-parses title, outgoing links, mentions, hashtags, then rebuilds maps.
   */
  updateEntry(relPath: string, content: string): void {
    const existing = this._byRelPath.get(relPath);
    if (!existing) return;

    const parsed = parseNoteContent(content);
    existing.title = parsed.title || existing.filename.replace(/\.txt$/, '');
    existing.outgoingLinks = parsed.outgoingLinks;
    existing.mentions = parsed.mentions;
    existing.hashtags = parsed.hashtags;
    this.rebuildMaps();
  }

  /**
   * Add a brand new note to the index (e.g. after creating from a wiki-link).
   */
  addEntry(relPath: string, filename: string, content: string): void {
    const parsed = parseNoteContent(content);
    const isArchived = relPath.includes('/@Archive/');
    const isTrashed = relPath.includes('/@Trash/');
    this._entries.push({
      filename,
      title: parsed.title || filename.replace(/\.txt$/, ''),
      relPath,
      isArchived,
      isTrashed,
      outgoingLinks: parsed.outgoingLinks,
      mentions: parsed.mentions,
      hashtags: parsed.hashtags,
    });
    this.rebuildMaps();
  }

  /**
   * Search for all lines containing the given @mention across all notes.
   * Returns results grouped by note, active notes first.
   * Done/cancelled tasks are included but flagged so the UI can filter them.
   */
  async searchMention(mention: string): Promise<SearchResult[]> {
    const mentionLower = mention.toLowerCase();
    const mentionRe = new RegExp(
      `(?:^|(?<=\\s))${mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_/\\-&])`,
      'i',
    );

    const candidates = this._entries.filter((e) =>
      !e.isTrashed && e.mentions.some((m) => m.toLowerCase() === mentionLower)
    );

    return this.searchLines(candidates, mentionRe);
  }

  async searchHashtag(hashtag: string): Promise<SearchResult[]> {
    const hashtagLower = hashtag.toLowerCase();
    const hashtagRe = new RegExp(
      `(?:^|(?<=\\s))${hashtag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_/\\-&])`,
      'i',
    );

    const candidates = this._entries.filter((e) =>
      !e.isTrashed && e.hashtags.some((h) => h.toLowerCase() === hashtagLower)
    );

    return this.searchLines(candidates, hashtagRe);
  }

  private async searchLines(candidates: NoteEntry[], re: RegExp): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    await Promise.all(candidates.map(async (entry) => {
      try {
        const text = await readTextFile(entry.relPath, { baseDir: BaseDirectory.Home });
        const lines: SearchResult['lines'] = [];
        text.split('\n').forEach((line, idx) => {
          if (re.test(line)) {
            // + is a checklist item — treated as task for now, distinct behavior TBD
            const isDone = /^\s*[-+] \[x\] /.test(line) || /^\s*[-+] \[-\] /.test(line);
            lines.push({ lineNum: idx + 1, text: line, isDone });
          }
        });
        if (lines.length > 0) {
          results.push({ entry, lines });
        }
      } catch {
        // Skip unreadable files
      }
    }));

    results.sort((a, b) => {
      if (a.entry.isArchived !== b.entry.isArchived) return a.entry.isArchived ? 1 : -1;
      return a.entry.title.localeCompare(b.entry.title);
    });

    return results;
  }

  /** The path where a new note would be created (Notes/ root). */
  newNotePath(title: string): string {
    return `${NOTEPLAN_BASE}/Notes/${title}.txt`;
  }
}

export const noteIndex = new NoteIndex();
