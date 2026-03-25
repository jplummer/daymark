/**
 * Right-click context menu for sidebar folder and note rows.
 */

import { dismissTaskContextMenu } from './task-context-menu';
import type { TreeNode } from './sidebar-types';
import {
  archiveTreeNode,
  copySidebarRelativePath,
  duplicateNote,
  isInsideArchive,
  isInsideTrash,
  isRecentVirtualFolder,
  isSpecialNotesRootFolder,
  newNoteInFolder,
  newSubfolder,
  revealSidebarPath,
  renameTreeNode,
  trashTreeNode,
  type SidebarFsMutation,
} from './sidebar-fs';

export interface SidebarContextBridge {
  prepareFileMutation: () => Promise<void>;
  openNoteInNewWindow: (relPath: string) => Promise<void>;
  onError: (message: string) => void;
  afterFilesystemChange: (mutation: SidebarFsMutation) => Promise<void>;
}

let openMenuEl: HTMLDivElement | null = null;

function removeSidebarMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
}

function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
): { left: number; top: number } {
  const pad = 8;
  const maxLeft = window.innerWidth - menuWidth - pad;
  const maxTop = window.innerHeight - menuHeight - pad;
  return {
    left: Math.min(Math.max(pad, x), Math.max(pad, maxLeft)),
    top: Math.min(Math.max(pad, y), Math.max(pad, maxTop)),
  };
}

function appendDivider(menu: HTMLDivElement) {
  const d = document.createElement('div');
  d.className = 'task-context-menu-divider';
  d.setAttribute('role', 'separator');
  menu.appendChild(d);
}

function appendItem(
  menu: HTMLDivElement,
  label: string,
  onClick: () => void,
  disabled = false,
) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'task-context-menu-item';
  btn.setAttribute('role', 'menuitem');
  btn.textContent = label;
  btn.disabled = disabled;
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    removeSidebarMenu();
    onClick();
  });
  menu.appendChild(btn);
}

async function runFs(
  bridge: SidebarContextBridge,
  fn: () => Promise<SidebarFsMutation>,
) {
  try {
    await bridge.prepareFileMutation();
    const m = await fn();
    await bridge.afterFilesystemChange(m);
  } catch (e) {
    bridge.onError(String(e));
  }
}

function showFolderMenu(clientX: number, clientY: number, node: TreeNode, bridge: SidebarContextBridge) {
  dismissTaskContextMenu();
  removeSidebarMenu();

  const menu = document.createElement('div');
  menu.className = 'task-context-menu';
  menu.setAttribute('role', 'menu');

  const trashDis = isInsideTrash(node.relPath);
  const archiveDis = isInsideArchive(node.relPath);
  const renameDis = isSpecialNotesRootFolder(node);

  appendItem(menu, 'New note', () => {
    void runFs(bridge, () => newNoteInFolder(node.relPath));
  });
  appendItem(menu, 'New subfolder', () => {
    void runFs(bridge, () => newSubfolder(node.relPath));
  });
  appendDivider(menu);
  appendItem(menu, 'Show in Finder', () => {
    void revealSidebarPath(node.relPath).catch((e) => bridge.onError(String(e)));
  });
  appendItem(menu, 'Copy relative path', () => {
    void copySidebarRelativePath(node.relPath).catch((e) => bridge.onError(String(e)));
  });
  appendDivider(menu);
  appendItem(menu, 'Rename', () => {
    void runFs(bridge, () => renameTreeNode(node));
  }, renameDis);
  appendItem(menu, 'Archive', () => {
    void runFs(bridge, () => archiveTreeNode(node));
  }, archiveDis);
  appendItem(menu, 'Move to Trash', () => {
    void runFs(bridge, () => trashTreeNode(node));
  }, trashDis);

  mountMenu(menu, clientX, clientY);
}

function showNoteMenu(clientX: number, clientY: number, node: TreeNode, bridge: SidebarContextBridge) {
  dismissTaskContextMenu();
  removeSidebarMenu();

  const menu = document.createElement('div');
  menu.className = 'task-context-menu';
  menu.setAttribute('role', 'menu');

  const trashDis = isInsideTrash(node.relPath);
  const archiveDis = isInsideArchive(node.relPath);

  appendItem(menu, 'Open in new window', () => {
    void bridge.openNoteInNewWindow(node.relPath).catch((e) => bridge.onError(String(e)));
  });
  appendDivider(menu);
  appendItem(menu, 'Show in Finder', () => {
    void revealSidebarPath(node.relPath).catch((e) => bridge.onError(String(e)));
  });
  appendItem(menu, 'Copy relative path', () => {
    void copySidebarRelativePath(node.relPath).catch((e) => bridge.onError(String(e)));
  });
  appendDivider(menu);
  appendItem(menu, 'Duplicate', () => {
    void runFs(bridge, () => duplicateNote(node.relPath));
  });
  appendItem(menu, 'Rename', () => {
    void runFs(bridge, () => renameTreeNode(node));
  });
  appendItem(menu, 'Archive', () => {
    void runFs(bridge, () => archiveTreeNode(node));
  }, archiveDis);
  appendItem(menu, 'Move to Trash', () => {
    void runFs(bridge, () => trashTreeNode(node));
  }, trashDis);

  mountMenu(menu, clientX, clientY);
}

function mountMenu(menu: HTMLDivElement, clientX: number, clientY: number) {
  document.body.appendChild(menu);
  openMenuEl = menu;

  const rect = menu.getBoundingClientRect();
  const { left, top } = clampMenuPosition(clientX, clientY, rect.width, rect.height);
  menu.style.position = 'fixed';
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.zIndex = '10000';

  const scrollEl = document.getElementById('sidebar-scroll');
  const dismiss = () => {
    removeSidebarMenu();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', dismiss);
    scrollEl?.removeEventListener('scroll', dismiss);
  };

  const onDocDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) dismiss();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
  };

  requestAnimationFrame(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', dismiss);
    scrollEl?.addEventListener('scroll', dismiss, { passive: true });
  });
}

export function attachFolderContextMenu(
  rowEl: HTMLElement,
  node: TreeNode,
  bridge: SidebarContextBridge | undefined,
) {
  rowEl.addEventListener('contextmenu', (e) => {
    if (!bridge) return;
    if (isRecentVirtualFolder(node)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    showFolderMenu(e.clientX, e.clientY, node, bridge);
  });
}

export function attachNoteContextMenu(
  rowEl: HTMLElement,
  node: TreeNode,
  bridge: SidebarContextBridge | undefined,
) {
  rowEl.addEventListener('contextmenu', (e) => {
    if (!bridge) return;
    e.preventDefault();
    e.stopPropagation();
    showNoteMenu(e.clientX, e.clientY, node, bridge);
  });
}
