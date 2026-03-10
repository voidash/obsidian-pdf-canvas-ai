import { Notice, Menu } from 'obsidian';
import type { TFile } from 'obsidian';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import type PdfCanvasAiPlugin from '../main';
import { HIGHLIGHT_COLORS, COLOR_HEX } from '../types/annotations';
import type { HighlightColor, PageRect, Highlight } from '../types/annotations';

/** Minimal shape of an internal Obsidian canvas object used for node creation. */
interface InternalCanvasObj {
  createTextNode?: (opts: Record<string, unknown>) => unknown;
  addNode?: (data: Record<string, unknown>) => void;
  requestSave?: () => void;
}

/** Minimal shape of an internal Obsidian canvas node. */
interface InternalNodeObj {
  x?: number;
  y?: number;
  width?: number;
  contentBlockerEl?: HTMLElement;
}

/**
 * Renders a single PDF inline inside an Obsidian canvas node,
 * replacing the default PDF embed with our enhanced pdfjs renderer.
 *
 * Features:
 *  - HiDPI-aware canvas rendering
 *  - Text layer for selection
 *  - Annotation layer for Zotero-style highlights
 *  - Selection context menu: highlight, Ask Claude, Copy, Extract as Card
 *  - Auto-resize when the canvas node is resized
 */
export class CanvasInlinePdf {
  private containerEl: HTMLElement;
  private file: TFile;
  private plugin: PdfCanvasAiPlugin;
  private canvas: InternalCanvasObj;
  private node: InternalNodeObj;

  private pdfDoc: PDFDocumentProxy | null = null;
  private pagesEl!: HTMLElement;
  private selectionMenuEl!: HTMLElement;
  private renderedPages = new Set<number>();
  private pageObserver: IntersectionObserver | null = null;
  private renderTasks = new Map<number, { cancel(): void }>();
  private resizeObserver: ResizeObserver | null = null;
  private currentScale = 1.0;
  private destroyed = false;

  /** If set, only this page number is rendered (used for "spread pages" nodes). */
  private singlePage: number | null = null;

  // Selection state
  private selectedText = '';
  private selectedRects: PageRect[] = [];
  private selectedPageNum = 0;
  private mousedownHandler: ((e: MouseEvent) => void) | null = null;

  // Interactive mode: double-click to enable scrolling & text selection,
  // click outside or Escape to re-enable node dragging.
  private interactive = false;
  private blockerEl: HTMLElement | null = null;
  private blockerDblclickHandler: ((e: MouseEvent) => void) | null = null;
  private exitInteractiveHandler: ((e: PointerEvent) => void) | null = null;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    containerEl: HTMLElement,
    file: TFile,
    plugin: PdfCanvasAiPlugin,
    canvas: unknown,
    node: unknown,
    singlePageNum?: number,
  ) {
    this.containerEl = containerEl;
    this.file = file;
    this.plugin = plugin;
    this.canvas = canvas as InternalCanvasObj;
    this.node = node as InternalNodeObj;
    this.singlePage = singlePageNum ?? null;
  }

  async render(): Promise<void> {
    // Clear container
    this.containerEl.empty();
    this.containerEl.classList.remove('pdf-embed');
    this.containerEl.classList.add('pcai-canvas-pdf');
    if (this.singlePage !== null) {
      this.containerEl.classList.add('pcai-canvas-pdf-single');
    }

    // Scrollable container for pages
    const scrollContainer = this.containerEl.createDiv({ cls: 'pcai-canvas-scroll' });
    this.pagesEl = scrollContainer.createDiv({ cls: 'pcai-canvas-pages' });

    // In interactive mode, stop events from reaching the canvas (prevents drag/pan).
    // In normal mode, let events propagate so the node remains draggable.
    for (const evt of ['pointerdown', 'mousedown'] as const) {
      scrollContainer.addEventListener(evt, (e) => {
        if (this.interactive) e.stopPropagation();
      });
    }
    scrollContainer.addEventListener('wheel', (e) => {
      if (this.interactive) e.stopPropagation();
    });

    // Selection menu (hidden by default)
    this.buildSelectionMenu();

    // Load PDF
    try {
      const buffer = await this.plugin.app.vault.readBinary(this.file);
      if (this.destroyed) return;
      this.pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
      if (this.destroyed) {
        void this.pdfDoc.destroy();
        this.pdfDoc = null;
        return;
      }
    } catch (err) {
      if (this.destroyed) return;
      this.pagesEl.createDiv({
        cls: 'pcai-pdf-loading',
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    await this.createPagePlaceholders();
    if (this.destroyed) return;
    this.loadHighlights();

    // Resize handling — recompute scale when node is resized
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.destroyed) this.handleResize();
    });
    this.resizeObserver.observe(this.containerEl);

    // Text selection
    this.setupSelectionListener();

    // Interactive mode toggle (double-click to enter, click outside / Escape to exit)
    this.setupInteractiveToggle();
  }

  // ─── Page rendering ───────────────────────────────────────────────────────

  private async createPagePlaceholders(): Promise<void> {
    if (!this.pdfDoc) return;

    this.pageObserver?.disconnect();
    this.pagesEl.empty();

    // Determine which pages to render
    const startPage = this.singlePage ?? 1;
    const endPage = this.singlePage ?? this.pdfDoc.numPages;

    // Compute scale to fit container width
    const refPage = await this.pdfDoc.getPage(startPage);
    const naturalWidth = refPage.getViewport({ scale: 1 }).width;
    const containerWidth = this.containerEl.clientWidth - (this.singlePage ? 0 : 16); // no padding for single page
    if (containerWidth > 0) {
      this.currentScale = containerWidth / naturalWidth;
    }

    this.pageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const num = parseInt(entry.target.getAttribute('data-page') ?? '0', 10);
          if (num > 0 && !this.renderedPages.has(num)) {
            this.renderedPages.add(num);
            this.renderPage(num).catch((e: unknown) => {
              console.error('PDF Tools — canvas renderPage error:', e);
            });
          }
        }
      },
      { root: this.pagesEl.parentElement, rootMargin: '200px', threshold: 0 },
    );

    for (let i = startPage; i <= endPage; i++) {
      const page = await this.pdfDoc.getPage(i);
      const vp = page.getViewport({ scale: this.currentScale });

      const wrapper = this.pagesEl.createDiv({
        cls: 'pcai-page-wrapper pcai-page-placeholder',
        attr: { 'data-page': String(i) },
      });
      wrapper.setCssStyles({ width: `${vp.width}px`, height: `${vp.height}px` });

      this.pageObserver.observe(wrapper);
    }
  }

  private async renderPage(pageNum: number): Promise<void> {
    if (!this.pdfDoc || this.destroyed) return;

    this.renderTasks.get(pageNum)?.cancel();

    const wrapper = this.pagesEl.querySelector(
      `[data-page="${pageNum}"]`,
    );
    if (!wrapper || !(wrapper instanceof HTMLElement)) return;
    wrapper.empty();
    wrapper.removeClass('pcai-page-placeholder');

    const page = await this.pdfDoc.getPage(pageNum);
    const vp = page.getViewport({ scale: this.currentScale });

    // Canvas layer (HiDPI)
    const dpr = window.devicePixelRatio || 1;
    const canvas = wrapper.createEl('canvas', {
      cls: 'pcai-page-canvas',
    });
    canvas.width = Math.round(vp.width * dpr);
    canvas.height = Math.round(vp.height * dpr);
    canvas.setCssStyles({ width: `${vp.width}px`, height: `${vp.height}px` });
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (dpr !== 1) ctx.scale(dpr, dpr);

    const renderTask = page.render({ canvasContext: ctx, viewport: vp });
    this.renderTasks.set(pageNum, renderTask);
    try {
      await renderTask.promise;
    } catch (err) {
      if ((err as { name?: string }).name === 'RenderingCancelledException') return;
      throw err;
    } finally {
      this.renderTasks.delete(pageNum);
    }

    if (this.destroyed) return;

    // Text layer
    const textLayerEl = wrapper.createDiv({ cls: 'textLayer' });
    textLayerEl.setCssStyles({ width: `${vp.width}px`, height: `${vp.height}px` });
    textLayerEl.setCssProps({ '--scale-factor': String(this.currentScale) });

    const textContent = await page.getTextContent();
    const textRenderTask = pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayerEl,
      viewport: vp,
      textDivs: [],
    });
    await textRenderTask.promise;

    // Annotation layer
    wrapper.createDiv({ cls: 'pcai-annotation-layer' });
    this.applyHighlightsToPage(pageNum);
  }

  private async rerenderAllPages(): Promise<void> {
    if (!this.pdfDoc || this.destroyed) return;

    for (const task of this.renderTasks.values()) task.cancel();
    this.renderTasks.clear();
    this.renderedPages.clear();
    this.pageObserver?.disconnect();

    await this.createPagePlaceholders();
    this.loadHighlights();
  }

  // ─── Resize ───────────────────────────────────────────────────────────────

  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  private handleResize(): void {
    // Debounce resize events
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (!this.pdfDoc || this.destroyed) return;
      const containerWidth = this.containerEl.clientWidth - (this.singlePage ? 0 : 16);
      if (containerWidth <= 0) return;

      void this.pdfDoc
        .getPage(1)
        .then((page) => {
          const naturalWidth = page.getViewport({ scale: 1 }).width;
          const newScale = containerWidth / naturalWidth;
          if (Math.abs(newScale - this.currentScale) < 0.01) return;
          this.currentScale = newScale;
          return this.rerenderAllPages();
        })
        .catch(() => {});
    }, 300);
  }

  // ─── Selection menu ───────────────────────────────────────────────────────

  private buildSelectionMenu(): void {
    this.selectionMenuEl = this.containerEl.createDiv('pcai-sel-menu pcai-hidden');

    // Highlight color dots
    const colors = this.selectionMenuEl.createDiv('pcai-sel-colors');
    for (const color of HIGHLIGHT_COLORS) {
      const dot = colors.createEl('button', {
        cls: 'pcai-sel-dot',
        attr: { title: `Highlight ${color}` },
      });
      dot.setCssProps({ '--dot-color': COLOR_HEX[color] });
      dot.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.createHighlight(color);
      });
    }

    this.selectionMenuEl.createDiv('pcai-sel-divider');

    const actions = this.selectionMenuEl.createDiv('pcai-sel-actions');

    const askBtn = actions.createEl('button', { cls: 'pcai-sel-btn', text: 'Ask AI' });
    askBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.askAboutSelection();
    });

    const copyBtn = actions.createEl('button', { cls: 'pcai-sel-btn', text: 'Copy' });
    copyBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(this.selectedText).catch(() => {
        new Notice('Copy failed.');
      });
      this.hideSelectionMenu();
      window.getSelection()?.removeAllRanges();
    });

    const extractBtn = actions.createEl('button', {
      cls: 'pcai-sel-btn pcai-sel-btn--accent',
      text: 'Extract',
    });
    extractBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.extractAsCard();
    });

    // Close menu on clicks outside
    this.mousedownHandler = (e: MouseEvent) => {
      if (!this.selectionMenuEl.contains(e.target as Node)) {
        this.hideSelectionMenu();
      }
    };
    document.addEventListener('mousedown', this.mousedownHandler);
  }

  private setupSelectionListener(): void {
    const scrollContainer = this.pagesEl.parentElement;
    if (!scrollContainer) return;
    scrollContainer.addEventListener('mouseup', (e: MouseEvent) => {
      setTimeout(() => this.checkSelection(e), 10);
    });
  }

  private checkSelection(_e: MouseEvent): void {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      this.hideSelectionMenu();
      return;
    }

    const text = selection.toString().trim();
    if (!text) {
      this.hideSelectionMenu();
      return;
    }

    const range = selection.getRangeAt(0);
    const startNode = range.startContainer;
    const pageWrapper = (
      startNode.nodeType === Node.TEXT_NODE
        ? startNode.parentElement
        : (startNode as Element)
    )?.closest('.pcai-page-wrapper') as HTMLElement | null;

    if (!pageWrapper) {
      this.hideSelectionMenu();
      return;
    }

    const pageNum = parseInt(pageWrapper.getAttribute('data-page')!, 10);
    const pageRect = pageWrapper.getBoundingClientRect();
    const clientRects = Array.from(range.getClientRects()).filter(
      (r) => r.width > 0 && r.height > 0,
    );

    if (clientRects.length === 0) {
      this.hideSelectionMenu();
      return;
    }

    this.selectedRects = clientRects.map((r) => ({
      x: (r.left - pageRect.left) / pageRect.width,
      y: (r.top - pageRect.top) / pageRect.height,
      width: r.width / pageRect.width,
      height: r.height / pageRect.height,
    }));
    this.selectedText = text;
    this.selectedPageNum = pageNum;

    // Position menu near end of selection, relative to our container
    const lastRect = clientRects[clientRects.length - 1];
    const containerRect = this.containerEl.getBoundingClientRect();
    const menuLeft = Math.min(
      lastRect.left - containerRect.left,
      containerRect.width - 280,
    );
    const menuTop = lastRect.bottom - containerRect.top + 6;

    this.selectionMenuEl.setCssStyles({ left: `${Math.max(0, menuLeft)}px`, top: `${menuTop}px` });
    this.selectionMenuEl.removeClass('pcai-hidden');
  }

  private hideSelectionMenu(): void {
    if (this.selectionMenuEl) {
      this.selectionMenuEl.addClass('pcai-hidden');
    }
  }

  // ─── Highlights ───────────────────────────────────────────────────────────

  private createHighlight(color: HighlightColor): void {
    if (!this.selectedText || this.selectedRects.length === 0) return;

    const h = this.plugin.annotationStore.add(
      this.file.path,
      this.selectedPageNum,
      this.selectedText,
      color,
      this.selectedRects,
    );

    this.renderHighlightOnPage(this.selectedPageNum, h);
    this.hideSelectionMenu();
    window.getSelection()?.removeAllRanges();
  }

  private loadHighlights(): void {
    for (const pageNum of this.renderedPages) {
      this.applyHighlightsToPage(pageNum);
    }
  }

  private applyHighlightsToPage(pageNum: number): void {
    const wrapper = this.pagesEl.querySelector(
      `[data-page="${pageNum}"]`,
    );
    if (!wrapper) return;
    const layer = wrapper.querySelector(
      '.pcai-annotation-layer',
    );
    if (!layer) return;

    layer.empty();
    this.plugin.annotationStore
      .getForPage(this.file.path, pageNum)
      .forEach((h) => this.renderHighlightOnPage(pageNum, h));
  }

  private renderHighlightOnPage(pageNum: number, h: Highlight): void {
    const wrapper = this.pagesEl.querySelector(
      `[data-page="${pageNum}"]`,
    );
    if (!wrapper) return;
    const layer = wrapper.querySelector(
      '.pcai-annotation-layer',
    );
    if (!layer) return;

    for (const rect of h.rects) {
      const div = layer.createDiv({ cls: `pcai-highlight pcai-hl-${h.color}` });
      div.setCssStyles({
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`,
        backgroundColor: COLOR_HEX[h.color],
      });
      div.title = h.text;
      div.dataset.highlightId = h.id;

      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showHighlightContextMenu(h, e);
      });
    }
  }

  private showHighlightContextMenu(h: Highlight, e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('Ask AI about this highlight')
        .setIcon('bot')
        .onClick(() => void this.askAboutHighlight(h)),
    );
    menu.addItem((item) =>
      item
        .setTitle('Extract as card')
        .setIcon('file-plus')
        .onClick(() => {
          this.selectedText = h.text;
          this.extractAsCard();
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle('Delete highlight')
        .setIcon('trash')
        .onClick(() => {
          this.plugin.annotationStore.remove(h.id);
          this.applyHighlightsToPage(h.pageNumber);
        }),
    );
    menu.showAtMouseEvent(e);
  }

  // ─── AI integration ───────────────────────────────────────────────────────

  private async askAboutSelection(): Promise<void> {
    const text = this.selectedText;
    this.hideSelectionMenu();
    window.getSelection()?.removeAllRanges();

    await this.plugin.activateAiSidebar();
    const view = this.plugin.getAiSidebarView();
    if (view) {
      view.setCurrentPdf(this.file);
      view.prefillQuestion(`Regarding this passage:\n\n> ${text}\n\n`);
      view.setContextScope('pdf');
    }
  }

  private async askAboutHighlight(h: Highlight): Promise<void> {
    await this.plugin.activateAiSidebar();
    const view = this.plugin.getAiSidebarView();
    if (view) {
      view.setCurrentPdf(this.file);
      view.prefillQuestion(
        `Regarding this highlighted passage:\n\n> ${h.text}\n\n`,
      );
      view.setContextScope('pdf');
    }
  }

  // ─── Extract as Card (Heptabase-style concept extraction) ─────────────────

  private extractAsCard(): void {
    const text = this.selectedText;
    if (!text) {
      new Notice('PDF tools: No text selected.');
      return;
    }

    this.hideSelectionMenu();
    window.getSelection()?.removeAllRanges();

    try {
      // Position new card to the right of this PDF node
      const nodeX = this.node.x ?? 0;
      const nodeY = this.node.y ?? 0;
      const nodeW = this.node.width ?? 400;

      const newX = nodeX + nodeW + 60;
      const newY = nodeY;
      const newW = 360;
      const newH = Math.min(400, Math.max(200, text.length * 0.8));

      // Format as a blockquote with source attribution
      const cardText = `> ${text}\n\n— *${this.file.basename}*`;

      // Try canvas API methods for creating text nodes
      if (typeof this.canvas.createTextNode === 'function') {
        this.canvas.createTextNode({
          pos: { x: newX, y: newY },
          size: { width: newW, height: newH },
          text: cardText,
          focus: false,
        });
      } else if (typeof this.canvas.addNode === 'function') {
        // Fallback: older canvas API
        const nodeData = {
          id: crypto.randomUUID(),
          type: 'text',
          x: newX,
          y: newY,
          width: newW,
          height: newH,
          text: cardText,
        };
        this.canvas.addNode(nodeData);
      } else {
        new Notice(
          'PDF tools: Cannot create card — canvas API not available.',
        );
        return;
      }

      // Save the canvas state
      if (typeof this.canvas.requestSave === 'function') {
        this.canvas.requestSave();
      }

      new Notice('PDF tools: Concept card created.');
    } catch (err) {
      console.error('PDF Tools — extractAsCard error:', err);
      new Notice('PDF tools: Failed to create card on canvas.');
    }
  }

  // ─── Interactive mode ─────────────────────────────────────────────────

  private setupInteractiveToggle(): void {
    this.blockerEl = this.node?.contentBlockerEl ?? null;
    if (!this.blockerEl) {
      // No content blocker — default to always interactive
      this.interactive = true;
      return;
    }

    this.blockerEl.title = 'Double-click to interact with PDF';
    this.blockerEl.addClass('pcai-cursor-pointer');

    this.blockerDblclickHandler = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.enterInteractiveMode();
    };
    this.blockerEl.addEventListener('dblclick', this.blockerDblclickHandler);
  }

  private enterInteractiveMode(): void {
    if (this.interactive || this.destroyed) return;
    this.interactive = true;
    if (this.blockerEl) this.blockerEl.addClass('pcai-no-pointer-events');
    this.containerEl.classList.add('pcai-interactive');

    // Click outside the canvas node to exit
    this.exitInteractiveHandler = (e: PointerEvent) => {
      const nodeEl = this.containerEl.closest('.canvas-node');
      if (nodeEl && !nodeEl.contains(e.target as Node)) {
        this.exitInteractiveMode();
      }
    };

    // Escape key to exit
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.exitInteractiveMode();
    };

    // Delay so the current double-click doesn't immediately trigger exit
    setTimeout(() => {
      if (this.destroyed) return;
      document.addEventListener('pointerdown', this.exitInteractiveHandler!, true);
      document.addEventListener('keydown', this.escHandler!, true);
    }, 100);
  }

  private exitInteractiveMode(): void {
    if (!this.interactive) return;
    this.interactive = false;
    if (this.blockerEl) this.blockerEl.removeClass('pcai-no-pointer-events');
    this.containerEl.classList.remove('pcai-interactive');

    if (this.exitInteractiveHandler) {
      document.removeEventListener('pointerdown', this.exitInteractiveHandler, true);
      this.exitInteractiveHandler = null;
    }
    if (this.escHandler) {
      document.removeEventListener('keydown', this.escHandler, true);
      this.escHandler = null;
    }
    window.getSelection()?.removeAllRanges();
    this.hideSelectionMenu();
  }

  /** Returns the page number most visible in the current scroll position. */
  getCurrentVisiblePage(): number {
    if (this.singlePage !== null) return this.singlePage;
    if (!this.pdfDoc) return 1;
    const scrollEl = this.pagesEl?.parentElement;
    if (!scrollEl) return 1;

    const scrollCenter = scrollEl.scrollTop + scrollEl.clientHeight / 2;
    let bestPage = 1;
    let bestDist = Infinity;

    for (const el of Array.from(this.pagesEl.querySelectorAll('.pcai-page-wrapper'))) {
      const htmlEl = el as HTMLElement;
      const num = parseInt(htmlEl.getAttribute('data-page') ?? '0', 10);
      if (num <= 0) continue;
      const center = htmlEl.offsetTop + htmlEl.offsetHeight / 2;
      const dist = Math.abs(center - scrollCenter);
      if (dist < bestDist) {
        bestDist = dist;
        bestPage = num;
      }
    }
    return bestPage;
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  destroy(): void {
    this.destroyed = true;
    this.exitInteractiveMode();
    if (this.blockerDblclickHandler && this.blockerEl) {
      this.blockerEl.removeEventListener('dblclick', this.blockerDblclickHandler);
      this.blockerDblclickHandler = null;
    }
    this.resizeObserver?.disconnect();
    this.pageObserver?.disconnect();
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    for (const task of this.renderTasks.values()) task.cancel();
    this.renderTasks.clear();
    if (this.mousedownHandler) {
      document.removeEventListener('mousedown', this.mousedownHandler);
      this.mousedownHandler = null;
    }
    void this.pdfDoc?.destroy();
    this.pdfDoc = null;
  }
}
