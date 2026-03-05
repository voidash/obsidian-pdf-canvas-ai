import { TFile } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type PdfCanvasAiPlugin from '../main';
import { CanvasInlinePdf } from './canvasInlinePdf';

/**
 * Monitors canvas views for PDF file nodes and replaces Obsidian's
 * default embed with our pdfjs renderer (highlights, AI, extract-as-card).
 *
 * Canvas node objects expose:
 *   node.contentEl  →  .canvas-node-content.pdf-embed
 *   node.file       →  TFile
 */
export class CanvasPdfInjector {
  private plugin: PdfCanvasAiPlugin;
  private renderers = new Map<HTMLElement, CanvasInlinePdf>();
  private observers = new Map<WorkspaceLeaf, MutationObserver>();
  private scanTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(plugin: PdfCanvasAiPlugin) {
    this.plugin = plugin;
  }

  start(): void {
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('layout-change', () => this.scheduleScan()),
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('active-leaf-change', () => this.scheduleScan()),
    );
    this.scheduleScan();
  }

  private scheduleScan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => this.scan(), 300);
  }

  private scan(): void {
    const leaves = this.plugin.app.workspace.getLeavesOfType('canvas');

    for (const leaf of leaves) {
      // Watch each canvas subtree so drag-and-drop PDF additions trigger re-scan
      if (!this.observers.has(leaf)) {
        const mo = new MutationObserver(() => this.scheduleScan());
        mo.observe(leaf.view.containerEl, { childList: true, subtree: true });
        this.observers.set(leaf, mo);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const canvas = (leaf.view as any)?.canvas;
      if (!canvas?.nodes) continue;

      for (const node of canvas.nodes.values()) {
        const file = node.file;
        if (!(file instanceof TFile) || file.extension !== 'pdf') continue;

        const el: HTMLElement | undefined = node.contentEl;
        if (!el) continue;
        if (this.renderers.has(el)) continue;
        // Only inject into fresh pdf-embed elements
        if (!el.classList.contains('pdf-embed')) continue;

        // Disable the content blocker so users can select text directly.
        // The node can still be moved via edges, corners, or the label.
        const blocker: HTMLElement | undefined = node.contentBlockerEl;
        if (blocker) blocker.style.pointerEvents = 'none';

        const renderer = new CanvasInlinePdf(el, file, this.plugin, canvas, node);
        this.renderers.set(el, renderer);
        renderer.render().catch((e: unknown) => {
          console.error('PDF Canvas AI — injection error:', e);
          this.renderers.delete(el);
        });
      }
    }

    // Tear down observers for closed canvases
    for (const [leaf, mo] of this.observers) {
      if (!leaves.includes(leaf)) {
        mo.disconnect();
        this.observers.delete(leaf);
      }
    }
  }

  stop(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    for (const mo of this.observers.values()) mo.disconnect();
    this.observers.clear();
    for (const r of this.renderers.values()) r.destroy();
    this.renderers.clear();
  }
}
