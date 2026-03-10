import { TFile } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type PdfCanvasAiPlugin from '../main';
import { CanvasInlinePdf } from './canvasInlinePdf';

/** Regex to extract spread-page marker from text node content. */
const SPREAD_MARKER_RE = /%%pcai-spread:(.+?):(\d+)%%/;

/** Minimal shape of internal Obsidian canvas node objects used during scanning. */
interface InternalCanvasNode {
  contentEl?: HTMLElement;
  file?: unknown;
  getData?: () => Record<string, unknown>;
  [key: string]: unknown;
}

/** Minimal shape of the internal Obsidian canvas object. */
interface InternalCanvas {
  nodes?: Map<string, InternalCanvasNode>;
  [key: string]: unknown;
}

/**
 * Monitors canvas views for PDF file nodes and spread-page text nodes,
 * replacing default embeds with our pdfjs renderer.
 *
 * Canvas node objects expose:
 *   node.contentEl  →  .canvas-node-content.pdf-embed (file nodes)
 *   node.file       →  TFile (file nodes only)
 *   node.getData()  →  { type, text, ... } (text nodes)
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

      const canvas = (leaf.view as { canvas?: InternalCanvas })?.canvas;
      if (!canvas?.nodes) continue;

      for (const node of canvas.nodes.values()) {
        const el: HTMLElement | undefined = node.contentEl;
        if (!el) continue;
        if (this.renderers.has(el)) continue;

        // ── PDF file nodes: replace native embed ──
        const file = node.file;
        if (file instanceof TFile && file.extension === 'pdf') {
          if (!el.classList.contains('pdf-embed')) continue;

          const renderer = new CanvasInlinePdf(el, file, this.plugin, canvas, node);
          this.renderers.set(el, renderer);
          renderer.render().catch((e: unknown) => {
            console.error('PDF Tools — injection error:', e);
            this.renderers.delete(el);
          });
          continue;
        }

        // ── Spread-page text nodes: render single PDF page ──
        this.tryInjectSpreadPage(el, node, canvas);
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

  private tryInjectSpreadPage(el: HTMLElement, node: unknown, canvas: unknown): void {
    let text: string | undefined;
    try {
      const n = node as Record<string, unknown>;
      const data = typeof n.getData === 'function'
        ? (n.getData as () => Record<string, unknown>)()
        : null;
      if (data?.type !== 'text') return;
      text = data.text as string | undefined;
    } catch {
      return;
    }
    if (!text) return;

    const match = text.match(SPREAD_MARKER_RE);
    if (!match) return;

    const filePath = match[1];
    const pageNum = parseInt(match[2], 10);
    if (isNaN(pageNum) || pageNum < 1) return;

    const abstractFile = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(abstractFile instanceof TFile) || abstractFile.extension !== 'pdf') return;

    const renderer = new CanvasInlinePdf(
      el, abstractFile, this.plugin, canvas, node, pageNum,
    );
    this.renderers.set(el, renderer);
    renderer.render().catch((e: unknown) => {
      console.error('PDF Tools — spread page injection error:', e);
      this.renderers.delete(el);
    });
  }

  /** Look up the renderer for a given canvas node, if one exists. */
  getRendererForNode(node: unknown): CanvasInlinePdf | null {
    const el = (node as { contentEl?: HTMLElement })?.contentEl;
    if (!el) return null;
    return this.renderers.get(el) ?? null;
  }

  stop(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    for (const mo of this.observers.values()) mo.disconnect();
    this.observers.clear();
    for (const r of this.renderers.values()) r.destroy();
    this.renderers.clear();
  }
}
