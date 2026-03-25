/**
 * File operations for sidebar context menu (NotePlan notes tree under Home).
 */

import {
  BaseDirectory,
  copyFile,
  exists,
  mkdir,
  rename,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
import { homeDir, join } from '@tauri-apps/api/path';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { RECENT_FOLDER_KEY, type TreeNode } from './sidebar-types';

const NOTEPLAN_BASE =
  'Library/Containers/co.noteplan.NotePlan-setapp/Data/Library/Application Support/co.noteplan.NotePlan-setapp';

const NOTES_ROOT = `${NOTEPLAN_BASE}/Notes`;
const ARCHIVE_DIR = `${NOTES_ROOT}/@Archive`;
const TRASH_DIR = `${NOTES_ROOT}/@Trash`;

const bd = { baseDir: BaseDirectory.Home };

export type SidebarFsMutation =
  | { kind: 'note-path-changed'; from: string; to: string }
  | { kind: 'none' };

function fileBasename(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? relPath : relPath.slice(i + 1);
}

function parentPath(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
}

async function pathExists(relPath: string): Promise<boolean> {
  return exists(relPath, bd);
}

async function uniqueFileNameInDir(dirRel: string, desiredName: string): Promise<string> {
  if (!(await pathExists(`${dirRel}/${desiredName}`))) return desiredName;
  const m = desiredName.match(/^(.+?)(\d*)(\.txt)$/i);
  const stem = m ? m[1].replace(/\s+$/, '') : desiredName.replace(/\.txt$/i, '');
  let n = 2;
  for (;;) {
    const candidate = `${stem} ${n}.txt`;
    if (!(await pathExists(`${dirRel}/${candidate}`))) return candidate;
    n++;
  }
}

async function uniqueFolderNameInDir(dirRel: string, desiredName: string): Promise<string> {
  if (!(await pathExists(`${dirRel}/${desiredName}`))) return desiredName;
  const stem = desiredName.replace(/\s+$/, '');
  let n = 2;
  for (;;) {
    const candidate = `${stem} ${n}`;
    if (!(await pathExists(`${dirRel}/${candidate}`))) return candidate;
    n++;
  }
}

async function ensureDir(relPath: string): Promise<void> {
  if (!(await pathExists(relPath))) {
    await mkdir(relPath, { ...bd, recursive: true });
  }
}

export function isRecentVirtualFolder(node: TreeNode): boolean {
  return node.isDir && node.relPath === RECENT_FOLDER_KEY;
}

export function isInsideArchive(relPath: string): boolean {
  return relPath.includes('/@Archive/') || relPath.endsWith('/@Archive');
}

export function isInsideTrash(relPath: string): boolean {
  return relPath.includes('/@Trash/') || relPath.endsWith('/@Trash');
}

export function isSpecialNotesRootFolder(node: TreeNode): boolean {
  return node.isDir && (node.relPath === ARCHIVE_DIR || node.relPath === TRASH_DIR);
}

export function notesRelativePath(relPath: string): string {
  const prefix = `${NOTES_ROOT}/`;
  return relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath;
}

export async function revealSidebarPath(relPath: string): Promise<void> {
  const abs = await join(await homeDir(), relPath);
  await revealItemInDir(abs);
}

export async function copySidebarRelativePath(relPath: string): Promise<void> {
  const text = notesRelativePath(relPath);
  await navigator.clipboard.writeText(text);
}

export async function newNoteInFolder(folderRelPath: string): Promise<SidebarFsMutation> {
  const name = await uniqueFileNameInDir(folderRelPath, 'New note.txt');
  const rel = `${folderRelPath}/${name}`;
  const body = '# New note\n\n';
  await writeTextFile(rel, body, bd);
  return { kind: 'none' };
}

export async function newSubfolder(parentRelPath: string): Promise<SidebarFsMutation> {
  const raw = window.prompt('Folder name:', 'New folder')?.trim();
  if (!raw || raw.includes('/') || raw === '.' || raw === '..') return { kind: 'none' };
  const folderName = await uniqueFolderNameInDir(parentRelPath, raw);
  await mkdir(`${parentRelPath}/${folderName}`, { ...bd, recursive: true });
  return { kind: 'none' };
}

export async function renameTreeNode(node: TreeNode): Promise<SidebarFsMutation> {
  const parent = parentPath(node.relPath);
  if (!parent) return { kind: 'none' };

  const currentBase = node.isDir ? node.name : node.name.replace(/\.txt$/i, '');
  const next = window.prompt(node.isDir ? 'Rename folder:' : 'Rename note:', currentBase)?.trim();
  if (!next || next.includes('/') || next === '.' || next === '..') return { kind: 'none' };

  const newBase = node.isDir ? next : `${next.replace(/\.txt$/i, '')}.txt`;
  const toPath = `${parent}/${newBase}`;
  if (toPath === node.relPath) return { kind: 'none' };
  if (await pathExists(toPath)) {
    window.alert('A file or folder with that name already exists.');
    return { kind: 'none' };
  }

  await rename(node.relPath, toPath, { oldPathBaseDir: BaseDirectory.Home, newPathBaseDir: BaseDirectory.Home });

  if (!node.isDir && node.relPath.endsWith('.txt')) {
    return { kind: 'note-path-changed', from: node.relPath, to: toPath };
  }
  return { kind: 'none' };
}

export async function archiveTreeNode(node: TreeNode): Promise<SidebarFsMutation> {
  await ensureDir(ARCHIVE_DIR);
  const base = fileBasename(node.relPath);
  const destName = node.isDir
    ? await uniqueFolderNameInDir(ARCHIVE_DIR, base)
    : await uniqueFileNameInDir(ARCHIVE_DIR, base);
  const toPath = `${ARCHIVE_DIR}/${destName}`;

  await rename(node.relPath, toPath, { oldPathBaseDir: BaseDirectory.Home, newPathBaseDir: BaseDirectory.Home });

  if (!node.isDir && node.relPath.endsWith('.txt')) {
    return { kind: 'note-path-changed', from: node.relPath, to: toPath };
  }
  return { kind: 'none' };
}

export async function trashTreeNode(node: TreeNode): Promise<SidebarFsMutation> {
  await ensureDir(TRASH_DIR);
  const base = fileBasename(node.relPath);
  const destName = node.isDir
    ? await uniqueFolderNameInDir(TRASH_DIR, base)
    : await uniqueFileNameInDir(TRASH_DIR, base);
  const toPath = `${TRASH_DIR}/${destName}`;

  await rename(node.relPath, toPath, { oldPathBaseDir: BaseDirectory.Home, newPathBaseDir: BaseDirectory.Home });

  if (!node.isDir && node.relPath.endsWith('.txt')) {
    return { kind: 'note-path-changed', from: node.relPath, to: toPath };
  }
  return { kind: 'none' };
}

export async function duplicateNote(relPath: string): Promise<SidebarFsMutation> {
  const parent = parentPath(relPath);
  const base = fileBasename(relPath);
  const stem = base.replace(/\.txt$/i, '');
  const destName = await uniqueFileNameInDir(parent, `Copy of ${stem}.txt`);
  const toPath = `${parent}/${destName}`;
  await copyFile(relPath, toPath, {
    fromPathBaseDir: BaseDirectory.Home,
    toPathBaseDir: BaseDirectory.Home,
  });
  return { kind: 'none' };
}
