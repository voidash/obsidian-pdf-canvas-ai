import type { App } from 'obsidian';
import { ItemView, TFile } from 'obsidian';

export interface CanvasPdfNode {
  file: TFile;
  /** The raw canvas node object (internal Obsidian API) */
  node: unknown;
}

function getActiveCanvas(app: App): object | null {
  // First try the active view
  const active = app.workspace.getActiveViewOfType(ItemView) as (ItemView & { canvas?: object }) | null;
  if (active && active.getViewType() === 'canvas' && active.canvas) {
    return active.canvas;
  }

  // When the sidebar is focused, the active view isn't the canvas.
  // Search all leaves for the most recent canvas view.
  const canvasLeaves = app.workspace.getLeavesOfType('canvas');
  if (canvasLeaves.length > 0) {
    const view = canvasLeaves[0].view as { canvas?: object };
    return view.canvas ?? null;
  }

  return null;
}

function resolveNodeFile(app: App, node: unknown): TFile | null {
  const n = node as { file?: unknown };
  if (!n.file) return null;
  if (n.file instanceof TFile) return n.file;
  if (typeof n.file === 'string') {
    const f = app.vault.getAbstractFileByPath(n.file);
    return f instanceof TFile ? f : null;
  }
  return null;
}

function isPdfNode(app: App, node: unknown): boolean {
  const file = resolveNodeFile(app, node);
  return file?.extension === 'pdf';
}

/** Returns PDF nodes currently selected on the active canvas. */
export function getSelectedPdfNodes(app: App): CanvasPdfNode[] {
  const canvas = getActiveCanvas(app) as { selection?: Set<unknown> } | null;
  if (!canvas?.selection) return [];

  const result: CanvasPdfNode[] = [];
  for (const node of canvas.selection) {
    if (!isPdfNode(app, node)) continue;
    const file = resolveNodeFile(app, node);
    if (file) result.push({ file, node });
  }
  return result;
}

/** Returns all PDF file nodes on the active canvas. */
export function getAllCanvasPdfNodes(app: App): CanvasPdfNode[] {
  const canvas = getActiveCanvas(app) as { nodes?: Map<string, unknown> } | null;
  if (!canvas?.nodes) return [];

  const result: CanvasPdfNode[] = [];
  for (const node of canvas.nodes.values()) {
    if (!isPdfNode(app, node)) continue;
    const file = resolveNodeFile(app, node);
    if (file) result.push({ file, node });
  }
  return result;
}
