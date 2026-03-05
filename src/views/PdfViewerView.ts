import { ItemView, WorkspaceLeaf, Notice, Menu, FuzzySuggestModal, App, TFile } from 'obsidian';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import type PdfCanvasAiPlugin from '../main';
import { HIGHLIGHT_COLORS, COLOR_HEX } from '../types/annotations';
import type { HighlightColor, PageRect, Highlight } from '../types/annotations';

export const PDF_VIEWER_VIEW_TYPE = 'pdf-canvas-ai-viewer';

const MIN_SCALE = 0.5;
const MAX_SCALE = 4.0;
const DEFAULT_SCALE = 1.5;

export class PdfViewerView extends ItemView {
  private plugin: PdfCanvasAiPlugin;

  // PDF state
  private currentFile: TFile | null = null;
  private pdfDoc: PDFDocumentProxy | null = null;
  private currentScale = DEFAULT_SCALE;
  private renderedPages = new Set<number>();
  private pageObserver: IntersectionObserver | null = null;
  private loadGeneration = 0;
  private renderTasks = new Map<number, { cancel(): void }>();

  // Text selection state
  private selectedText = '';
  private selectedRects: PageRect[] = [];
  private selectedPageNum = 0;

  // DOM refs — library panel
  private libraryEl!: HTMLElement;
  private fileListEl!: HTMLElement;
  private annotationsEl!: HTMLElement;
  private librarySearchEl!: HTMLInputElement;

  // DOM refs — viewer panel
  private pagesEl!: HTMLElement;
  private filenameLabelEl!: HTMLElement;
  private pageInfoEl!: HTMLElement;
  private selectionMenuEl!: HTMLElement;

  // Event handler refs for cleanup
  private mousedownHandler: ((e: MouseEvent) => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PdfCanvasAiPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return PDF_VIEWER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.currentFile?.name ?? 'PDF Library';
  }

  getIcon(): string {
    return 'file-text';
  }

  async onOpen(): Promise<void> {
    this.buildUI();
    this.refreshFileList();
  }

  // State persistence — allows Obsidian to open PDFs via file explorer, links, etc.
  getState(): Record<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = super.getState() as any;
    if (this.currentFile) {
      state.file = this.currentFile.path;
    }
    return state;
  }

  async setState(state: unknown, result: { history: boolean }): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = state as any;
    if (s?.file && typeof s.file === 'string') {
      const file = this.app.vault.getAbstractFileByPath(s.file);
      if (file instanceof TFile && file.extension === 'pdf') {
        await this.loadFile(file);
      }
    }
    await super.setState(state, result);
  }

  async onClose(): Promise<void> {
    if (this.mousedownHandler) {
      document.removeEventListener('mousedown', this.mousedownHandler);
      this.mousedownHandler = null;
    }
    for (const task of this.renderTasks.values()) {
      task.cancel();
    }
    this.renderTasks.clear();
    this.pageObserver?.disconnect();
    this.pdfDoc?.destroy();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  getCurrentFile(): TFile | null {
    return this.currentFile;
  }

  async loadFile(file: TFile): Promise<void> {
    if (this.currentFile?.path === file.path) return;

    this.hideSelectionMenu();
    this.currentFile = file;
    const gen = ++this.loadGeneration;

    this.renderedPages.clear();
    this.pdfDoc?.destroy();
    this.pdfDoc = null;
    this.pageObserver?.disconnect();
    this.pagesEl.empty();
    this.filenameLabelEl.setText(file.name);
    (this.leaf as unknown as { updateHeader?(): void }).updateHeader?.();

    // Highlight the active file in the library list
    this.highlightActiveFile();
    this.refreshAnnotations();

    const loadingEl = this.pagesEl.createDiv({ cls: 'pcai-pdf-loading', text: 'Loading PDF\u2026' });

    try {
      const buffer = await this.app.vault.readBinary(file);
      if (gen !== this.loadGeneration) return;

      this.pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
      if (gen !== this.loadGeneration) {
        this.pdfDoc.destroy();
        this.pdfDoc = null;
        return;
      }
    } catch (err) {
      if (gen !== this.loadGeneration) return;
      loadingEl.setText(`Error loading PDF: ${err instanceof Error ? err.message : String(err)}`);
      console.error('PDF Canvas AI \u2014 loadFile error:', err);
      return;
    }

    loadingEl.remove();
    this.pageInfoEl.setText(`0 / ${this.pdfDoc.numPages}`);

    await this.createPagePlaceholders();
    if (gen !== this.loadGeneration) return;
    this.loadHighlightsForCurrentFile();
  }

  // ─── UI construction ───────────────────────────────────────────────────────

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('pcai-pdf-root');

    // Two-panel layout: library | viewer
    const splitContainer = root.createDiv('pcai-split');

    this.buildLibraryPanel(splitContainer);
    this.buildViewerPanel(splitContainer);
    this.buildSelectionMenu(root);
    this.setupSelectionListener();
  }

  // ─── Library panel (left sidebar) ──────────────────────────────────────────

  private buildLibraryPanel(parent: HTMLElement): void {
    this.libraryEl = parent.createDiv('pcai-library');

    // ── File list section ──
    const filesSection = this.libraryEl.createDiv('pcai-library-section');
    const filesHeader = filesSection.createDiv('pcai-library-section-header');
    filesHeader.createSpan({ text: 'PDFs' });

    this.librarySearchEl = filesSection.createEl('input', {
      cls: 'pcai-library-search',
      attr: { type: 'text', placeholder: 'Filter\u2026' },
    }) as HTMLInputElement;
    this.librarySearchEl.addEventListener('input', () => this.refreshFileList());

    this.fileListEl = filesSection.createDiv('pcai-file-list');

    // ── Annotations section ──
    const annoSection = this.libraryEl.createDiv('pcai-library-section pcai-annotations-section');
    const annoHeader = annoSection.createDiv('pcai-library-section-header');
    annoHeader.createSpan({ text: 'Annotations' });

    this.annotationsEl = annoSection.createDiv('pcai-annotation-list');
    this.annotationsEl.createDiv({
      cls: 'pcai-anno-empty',
      text: 'Open a PDF to see annotations',
    });
  }

  private refreshFileList(): void {
    this.fileListEl.empty();
    const filter = this.librarySearchEl?.value?.toLowerCase() ?? '';

    const pdfFiles = this.app.vault
      .getFiles()
      .filter((f) => f.extension === 'pdf')
      .filter((f) => !filter || f.path.toLowerCase().includes(filter))
      .sort((a, b) => a.path.localeCompare(b.path));

    if (pdfFiles.length === 0) {
      this.fileListEl.createDiv({
        cls: 'pcai-file-empty',
        text: filter ? 'No matching PDFs' : 'No PDFs in vault',
      });
      return;
    }

    for (const file of pdfFiles) {
      const item = this.fileListEl.createDiv({
        cls: 'pcai-file-item',
        attr: { 'data-path': file.path },
      });

      // Show annotation count as a subtle badge
      const annotations = this.plugin.annotationStore.getForFile(file.path);
      const hasAnnotations = annotations.length > 0;

      item.createSpan({ cls: 'pcai-file-name', text: file.basename });
      if (hasAnnotations) {
        item.createSpan({
          cls: 'pcai-file-badge',
          text: String(annotations.length),
        });
      }

      if (this.currentFile?.path === file.path) {
        item.addClass('pcai-file-active');
      }

      item.addEventListener('click', () => {
        this.loadFile(file).catch((e: unknown) =>
          console.error('PDF Canvas AI \u2014 loadFile error:', e),
        );
      });

      // Tooltip with full path
      item.title = file.path;
    }
  }

  private highlightActiveFile(): void {
    this.fileListEl.querySelectorAll('.pcai-file-item').forEach((el) => {
      el.removeClass('pcai-file-active');
      if (el.getAttribute('data-path') === this.currentFile?.path) {
        el.addClass('pcai-file-active');
      }
    });
  }

  // ─── Annotations panel ─────────────────────────────────────────────────────

  refreshAnnotations(): void {
    this.annotationsEl.empty();

    if (!this.currentFile) {
      this.annotationsEl.createDiv({
        cls: 'pcai-anno-empty',
        text: 'Open a PDF to see annotations',
      });
      return;
    }

    const highlights = this.plugin.annotationStore.getForFile(this.currentFile.path);

    if (highlights.length === 0) {
      this.annotationsEl.createDiv({
        cls: 'pcai-anno-empty',
        text: 'No annotations yet. Select text to highlight.',
      });
      return;
    }

    // Group by page
    const byPage = new Map<number, Highlight[]>();
    for (const h of highlights) {
      const arr = byPage.get(h.pageNumber) ?? [];
      arr.push(h);
      byPage.set(h.pageNumber, arr);
    }

    const sortedPages = [...byPage.keys()].sort((a, b) => a - b);

    for (const page of sortedPages) {
      const pageGroup = this.annotationsEl.createDiv('pcai-anno-page-group');
      pageGroup.createDiv({
        cls: 'pcai-anno-page-label',
        text: `Page ${page}`,
      });

      const pageHighlights = byPage.get(page)!;
      for (const h of pageHighlights) {
        const card = pageGroup.createDiv('pcai-anno-card');
        card.addEventListener('click', (e) => {
          // Don't navigate if clicking an action button
          if ((e.target as HTMLElement).closest('.pcai-anno-actions')) return;
          this.scrollToPage(h.pageNumber);
        });

        // Color dot + text
        const row = card.createDiv('pcai-anno-row');
        const dot = row.createSpan('pcai-anno-dot');
        dot.style.setProperty('--dot-color', COLOR_HEX[h.color]);

        const textEl = row.createSpan({
          cls: 'pcai-anno-text',
          text: h.text.length > 120 ? h.text.slice(0, 120) + '\u2026' : h.text,
        });
        textEl.title = h.text;

        // Note (if present)
        if (h.note) {
          card.createDiv({ cls: 'pcai-anno-note', text: h.note });
        }

        // Actions row
        const actions = card.createDiv('pcai-anno-actions');

        const gotoBtn = actions.createEl('button', {
          cls: 'pcai-anno-action',
          text: 'Go to',
        });
        gotoBtn.addEventListener('click', () => this.scrollToPage(h.pageNumber));

        const askBtn = actions.createEl('button', {
          cls: 'pcai-anno-action',
          text: 'Ask AI',
        });
        askBtn.addEventListener('click', () => this.askAboutHighlight(h));

        const noteBtn = actions.createEl('button', {
          cls: 'pcai-anno-action',
          text: h.note ? 'Edit note' : 'Add note',
        });
        noteBtn.addEventListener('click', () => this.editAnnotationNote(h));

        const delBtn = actions.createEl('button', {
          cls: 'pcai-anno-action pcai-anno-action--danger',
          text: 'Delete',
        });
        delBtn.addEventListener('click', () => {
          this.plugin.annotationStore.remove(h.id);
          this.refreshAnnotations();
          this.applyHighlightsToPage(h.pageNumber);
          this.refreshFileList();
        });
      }
    }
  }

  private editAnnotationNote(h: Highlight): void {
    // Simple prompt-style note editor using a modal-like overlay
    const overlay = this.containerEl.createDiv('pcai-note-overlay');
    const dialog = overlay.createDiv('pcai-note-dialog');
    dialog.createEl('label', { text: 'Annotation note:', cls: 'pcai-note-label' });

    const textarea = dialog.createEl('textarea', {
      cls: 'pcai-note-textarea',
      attr: { rows: '4', placeholder: 'Add a note to this annotation\u2026' },
    }) as HTMLTextAreaElement;
    textarea.value = h.note ?? '';

    const btnRow = dialog.createDiv('pcai-note-btn-row');

    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => overlay.remove());

    const saveBtn = btnRow.createEl('button', { cls: 'mod-cta', text: 'Save' });
    saveBtn.addEventListener('click', () => {
      this.plugin.annotationStore.updateNote(h.id, textarea.value.trim());
      overlay.remove();
      this.refreshAnnotations();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    textarea.focus();
  }

  private scrollToPage(pageNum: number): void {
    const targetEl = this.pagesEl.querySelector(`[data-page="${pageNum}"]`) as HTMLElement | null;
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (this.pdfDoc) {
        this.pageInfoEl.setText(`${pageNum} / ${this.pdfDoc.numPages}`);
      }
    }
  }

  // ─── Viewer panel (right side) ─────────────────────────────────────────────

  private buildViewerPanel(parent: HTMLElement): void {
    const viewerPanel = parent.createDiv('pcai-viewer-panel');

    this.buildToolbar(viewerPanel);
    this.buildViewport(viewerPanel);
  }

  private buildToolbar(root: HTMLElement): void {
    const bar = root.createDiv('pcai-pdf-toolbar');

    const openBtn = bar.createEl('button', {
      cls: 'pcai-icon-btn pcai-open-btn',
      attr: { title: 'Open PDF from vault' },
      text: '\uD83D\uDCC2',
    });
    openBtn.addEventListener('click', () => this.openFilePicker());

    this.filenameLabelEl = bar.createSpan({ cls: 'pcai-pdf-filename', text: 'Select a PDF' });

    const navGroup = bar.createDiv('pcai-pdf-nav');

    const prevBtn = navGroup.createEl('button', { cls: 'pcai-icon-btn', attr: { title: 'Previous page' }, text: '\u25C0' });
    prevBtn.addEventListener('click', () => this.navigatePage(-1));

    this.pageInfoEl = navGroup.createSpan({ cls: 'pcai-pdf-page-info', text: '\u2014' });

    const nextBtn = navGroup.createEl('button', { cls: 'pcai-icon-btn', attr: { title: 'Next page' }, text: '\u25B6' });
    nextBtn.addEventListener('click', () => this.navigatePage(1));

    const zoomGroup = bar.createDiv('pcai-pdf-zoom');

    const zoomOutBtn = zoomGroup.createEl('button', { cls: 'pcai-icon-btn', attr: { title: 'Zoom out' }, text: '\u2212' });
    zoomOutBtn.addEventListener('click', () => this.adjustZoom(-0.25));

    const zoomInBtn = zoomGroup.createEl('button', { cls: 'pcai-icon-btn', attr: { title: 'Zoom in' }, text: '+' });
    zoomInBtn.addEventListener('click', () => this.adjustZoom(0.25));

    const fitBtn = zoomGroup.createEl('button', { cls: 'pcai-icon-btn', attr: { title: 'Fit to width' }, text: '\u2922' });
    fitBtn.addEventListener('click', () => this.fitToWidth());

    const aiBtn = bar.createEl('button', { cls: 'pcai-ask-btn mod-cta', text: 'Ask AI' });
    aiBtn.addEventListener('click', () => this.askAboutCurrentPdf());
  }

  private buildViewport(root: HTMLElement): void {
    const viewport = root.createDiv('pcai-pdf-viewport');
    this.pagesEl = viewport.createDiv('pcai-pdf-pages');
  }

  private buildSelectionMenu(root: HTMLElement): void {
    this.selectionMenuEl = root.createDiv('pcai-sel-menu');
    this.selectionMenuEl.style.display = 'none';

    const colors = this.selectionMenuEl.createDiv('pcai-sel-colors');
    for (const color of HIGHLIGHT_COLORS) {
      const dot = colors.createEl('button', {
        cls: 'pcai-sel-dot',
        attr: { title: `Highlight ${color}` },
      });
      dot.style.setProperty('--dot-color', COLOR_HEX[color]);
      dot.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.createHighlight(color);
      });
    }

    this.selectionMenuEl.createDiv('pcai-sel-divider');

    const actions = this.selectionMenuEl.createDiv('pcai-sel-actions');

    const askBtn = actions.createEl('button', { cls: 'pcai-sel-btn pcai-sel-btn--accent', text: 'Ask AI' });
    askBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.askAboutSelection();
    });

    const copyBtn = actions.createEl('button', { cls: 'pcai-sel-btn', text: 'Copy' });
    copyBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      navigator.clipboard.writeText(this.selectedText).catch((err: unknown) => {
        new Notice('PDF Canvas AI: Copy failed.');
        console.error('PDF Canvas AI \u2014 clipboard error:', err);
      });
      this.hideSelectionMenu();
      window.getSelection()?.removeAllRanges();
    });

    this.mousedownHandler = (e: MouseEvent) => {
      if (!this.selectionMenuEl.contains(e.target as Node)) {
        this.hideSelectionMenu();
      }
    };
    document.addEventListener('mousedown', this.mousedownHandler);
  }

  // ─── PDF rendering ─────────────────────────────────────────────────────────

  private async createPagePlaceholders(): Promise<void> {
    if (!this.pdfDoc) return;

    this.pageObserver?.disconnect();

    this.pageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const num = parseInt(entry.target.getAttribute('data-page') ?? '0', 10);
          if (num > 0 && !this.renderedPages.has(num)) {
            this.renderedPages.add(num);
            this.renderPage(num).catch((e: unknown) => {
              console.error('PDF Canvas AI \u2014 renderPage error:', e);
            });
          }
        }
      },
      { root: this.pagesEl.parentElement, rootMargin: '300px', threshold: 0 },
    );

    for (let i = 1; i <= this.pdfDoc.numPages; i++) {
      const page = await this.pdfDoc.getPage(i);
      const vp = page.getViewport({ scale: this.currentScale });

      const wrapper = this.pagesEl.createDiv({
        cls: 'pcai-page-wrapper pcai-page-placeholder',
        attr: { 'data-page': String(i) },
      });
      wrapper.style.width = `${vp.width}px`;
      wrapper.style.height = `${vp.height}px`;

      this.pageObserver.observe(wrapper);
    }
  }

  private async renderPage(pageNum: number): Promise<void> {
    if (!this.pdfDoc) return;

    this.renderTasks.get(pageNum)?.cancel();

    const wrapper = this.pagesEl.querySelector(`[data-page="${pageNum}"]`) as HTMLElement | null;
    if (!wrapper) return;
    wrapper.removeClass('pcai-page-placeholder');

    const page = await this.pdfDoc.getPage(pageNum);
    const vp = page.getViewport({ scale: this.currentScale });

    const dpr = window.devicePixelRatio || 1;
    const canvas = wrapper.createEl('canvas', { cls: 'pcai-page-canvas' }) as HTMLCanvasElement;
    canvas.width = Math.round(vp.width * dpr);
    canvas.height = Math.round(vp.height * dpr);
    canvas.style.width = `${vp.width}px`;
    canvas.style.height = `${vp.height}px`;
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

    const textLayerEl = wrapper.createDiv({ cls: 'textLayer' });
    textLayerEl.style.width = `${vp.width}px`;
    textLayerEl.style.height = `${vp.height}px`;
    textLayerEl.style.setProperty('--scale-factor', String(this.currentScale));

    const textContent = await page.getTextContent();
    const textRenderTask = pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayerEl,
      viewport: vp,
      textDivs: [],
    });
    await textRenderTask.promise;

    wrapper.createDiv({ cls: 'pcai-annotation-layer' });

    if (pageNum === 1) {
      this.pageInfoEl.setText(`1 / ${this.pdfDoc!.numPages}`);
    }

    this.applyHighlightsToPage(pageNum);
  }

  private async rerenderAllPages(): Promise<void> {
    if (!this.pdfDoc) return;

    for (const task of this.renderTasks.values()) {
      task.cancel();
    }
    this.renderTasks.clear();
    this.renderedPages.clear();
    this.pageObserver?.disconnect();

    // Clear all page elements and rebuild from scratch
    this.pagesEl.empty();
    await this.createPagePlaceholders();
    this.loadHighlightsForCurrentFile();
  }

  // ─── Navigation and zoom ───────────────────────────────────────────────────

  private navigatePage(delta: number): void {
    if (!this.pdfDoc) return;
    const wrappers = Array.from(this.pagesEl.querySelectorAll<HTMLElement>('[data-page]'));
    const viewportEl = this.pagesEl.parentElement!;
    const viewportCenter = viewportEl.scrollTop + viewportEl.clientHeight / 2;

    let currentPage = 1;
    for (const wrapper of wrappers) {
      const top = wrapper.offsetTop;
      if (top <= viewportCenter) currentPage = parseInt(wrapper.getAttribute('data-page')!, 10);
    }

    const target = Math.max(1, Math.min(this.pdfDoc.numPages, currentPage + delta));
    const targetEl = this.pagesEl.querySelector(`[data-page="${target}"]`) as HTMLElement | null;
    if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.pageInfoEl.setText(`${target} / ${this.pdfDoc.numPages}`);
  }

  private adjustZoom(delta: number): void {
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.currentScale + delta));
    if (newScale === this.currentScale) return;
    this.currentScale = newScale;
    this.rerenderAllPages().catch((e: unknown) => console.error('PDF Canvas AI \u2014 zoom error:', e));
  }

  private fitToWidth(): void {
    if (!this.pdfDoc) return;
    const viewportWidth = (this.pagesEl.parentElement?.clientWidth ?? 600) - 32;
    this.pdfDoc.getPage(1).then((page) => {
      const naturalWidth = page.getViewport({ scale: 1 }).width;
      this.currentScale = viewportWidth / naturalWidth;
      this.rerenderAllPages().catch((e: unknown) => console.error('PDF Canvas AI \u2014 fitToWidth error:', e));
    }).catch((e: unknown) => console.error('PDF Canvas AI \u2014 fitToWidth error:', e));
  }

  // ─── Text selection ────────────────────────────────────────────────────────

  private setupSelectionListener(): void {
    this.containerEl.addEventListener('mouseup', (e: MouseEvent) => {
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
    const startNode = range.startContainer as Node;
    const pageWrapper = (startNode.nodeType === Node.TEXT_NODE
      ? startNode.parentElement
      : startNode as Element
    )?.closest('.pcai-page-wrapper') as HTMLElement | null;

    if (!pageWrapper) {
      this.hideSelectionMenu();
      return;
    }

    const pageNum = parseInt(pageWrapper.getAttribute('data-page')!, 10);
    const pageRect = pageWrapper.getBoundingClientRect();
    const clientRects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);

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

    const lastRect = clientRects[clientRects.length - 1];
    const containerRect = this.containerEl.getBoundingClientRect();
    const menuLeft = Math.min(lastRect.left - containerRect.left, containerRect.width - 280);
    const menuTop = lastRect.bottom - containerRect.top + 6;

    this.selectionMenuEl.style.left = `${Math.max(0, menuLeft)}px`;
    this.selectionMenuEl.style.top = `${menuTop}px`;
    this.selectionMenuEl.style.display = 'flex';
  }

  private hideSelectionMenu(): void {
    this.selectionMenuEl.style.display = 'none';
  }

  // ─── Highlights ────────────────────────────────────────────────────────────

  private createHighlight(color: HighlightColor): void {
    if (!this.currentFile || !this.selectedText || this.selectedRects.length === 0) return;

    const h = this.plugin.annotationStore.add(
      this.currentFile.path,
      this.selectedPageNum,
      this.selectedText,
      color,
      this.selectedRects,
    );

    this.renderHighlightOnPage(this.selectedPageNum, h);

    // Flash newly created highlights
    const wrapper = this.pagesEl.querySelector(`[data-page="${this.selectedPageNum}"]`);
    if (wrapper) {
      wrapper.querySelectorAll(`[data-highlight-id="${h.id}"]`).forEach((el) => {
        el.addClass('pcai-highlight-new');
      });
    }

    this.hideSelectionMenu();
    window.getSelection()?.removeAllRanges();

    // Refresh the annotations sidebar and file list (badge count)
    this.refreshAnnotations();
    this.refreshFileList();
  }

  private loadHighlightsForCurrentFile(): void {
    for (const pageNum of this.renderedPages) {
      this.applyHighlightsToPage(pageNum);
    }
  }

  private applyHighlightsToPage(pageNum: number): void {
    if (!this.currentFile) return;
    const wrapper = this.pagesEl.querySelector(`[data-page="${pageNum}"]`) as HTMLElement | null;
    if (!wrapper) return;
    const layer = wrapper.querySelector('.pcai-annotation-layer') as HTMLElement | null;
    if (!layer) return;

    layer.empty();
    this.plugin.annotationStore
      .getForPage(this.currentFile.path, pageNum)
      .forEach((h) => this.renderHighlightOnPage(pageNum, h));
  }

  private renderHighlightOnPage(pageNum: number, h: Highlight): void {
    const wrapper = this.pagesEl.querySelector(`[data-page="${pageNum}"]`) as HTMLElement | null;
    if (!wrapper) return;

    const layer = wrapper.querySelector('.pcai-annotation-layer') as HTMLElement | null;
    if (!layer) return;

    for (const rect of h.rects) {
      const div = layer.createDiv({ cls: `pcai-highlight pcai-hl-${h.color}` });
      div.style.left = `${rect.x * 100}%`;
      div.style.top = `${rect.y * 100}%`;
      div.style.width = `${rect.width * 100}%`;
      div.style.height = `${rect.height * 100}%`;
      div.style.backgroundColor = COLOR_HEX[h.color];
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
        .onClick(() => this.askAboutHighlight(h)),
    );
    menu.addItem((item) =>
      item
        .setTitle('Add note')
        .setIcon('pencil')
        .onClick(() => this.editAnnotationNote(h)),
    );
    menu.addItem((item) =>
      item
        .setTitle('Delete highlight')
        .setIcon('trash')
        .onClick(() => {
          this.plugin.annotationStore.remove(h.id);
          this.applyHighlightsToPage(h.pageNumber);
          this.refreshAnnotations();
          this.refreshFileList();
        }),
    );
    menu.showAtMouseEvent(e);
  }

  // ─── AI integration ────────────────────────────────────────────────────────

  private async askAboutCurrentPdf(): Promise<void> {
    await this.plugin.activateAiSidebar();
    const view = this.plugin.getAiSidebarView();
    if (view) {
      if (this.currentFile) view.setCurrentPdf(this.currentFile);
      view.setContextScope('pdf');
    }
    new Notice('PDF Canvas AI: Type your question in the sidebar.');
  }

  private async askAboutSelection(): Promise<void> {
    const text = this.selectedText;
    this.hideSelectionMenu();
    window.getSelection()?.removeAllRanges();

    await this.plugin.activateAiSidebar();
    const view = this.plugin.getAiSidebarView();
    if (view) {
      if (this.currentFile) view.setCurrentPdf(this.currentFile);
      view.prefillQuestion(`Regarding this passage:\n\n> ${text}\n\n`);
      view.setContextScope('pdf');
    }
  }

  private async askAboutHighlight(h: Highlight): Promise<void> {
    await this.plugin.activateAiSidebar();
    const view = this.plugin.getAiSidebarView();
    if (view) {
      if (this.currentFile) view.setCurrentPdf(this.currentFile);
      view.prefillQuestion(`Regarding this highlighted passage:\n\n> ${h.text}\n\n`);
      view.setContextScope('pdf');
    }
  }

  // ─── File picker ───────────────────────────────────────────────────────────

  private openFilePicker(): void {
    new PdfFileSuggestModal(this.app, (file) => {
      this.loadFile(file).catch((e: unknown) =>
        console.error('PDF Canvas AI \u2014 loadFile error:', e),
      );
    }).open();
  }
}

// ─── Fuzzy PDF picker modal ─────────────────────────────────────────────────

class PdfFileSuggestModal extends FuzzySuggestModal<TFile> {
  private onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder('Type to search PDF files\u2026');
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((f) => f.extension === 'pdf');
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}
