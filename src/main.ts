import { Plugin, Notice, TFile, FileSystemAdapter, normalizePath, Menu, ItemView } from 'obsidian';
import type { EventRef } from 'obsidian';
import * as pdfjsLib from 'pdfjs-dist';

import { DEFAULT_SETTINGS, PdfCanvasAiSettingTab } from './settings';
import type { PluginSettings } from './settings';
import { AnnotationStore } from './store/annotationStore';
import { ChatStore } from './store/chatStore';
import { AiService } from './services/aiService';
import { PdfService } from './services/pdfService';
import { ProxyManager } from './services/proxyManager';
import { AI_SIDEBAR_VIEW_TYPE, AiSidebarView } from './views/AiSidebarView';
import { AI_CHAT_VIEW_TYPE, AiChatView } from './views/AiChatView';
import { PDF_VIEWER_VIEW_TYPE, PdfViewerView } from './views/PdfViewerView';
import { getSelectedPdfNodes, getAllCanvasPdfNodes } from './canvas/canvasUtils';
import { CanvasPdfInjector } from './canvas/canvasPdfInjector';

export default class PdfCanvasAiPlugin extends Plugin {
  settings!: PluginSettings;
  annotationStore!: AnnotationStore;
  chatStore!: ChatStore;
  aiService!: AiService;
  pdfService!: PdfService;
  proxyManager!: ProxyManager;
  canvasInjector!: CanvasPdfInjector;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.annotationStore = new AnnotationStore(this);
    await this.annotationStore.load();

    this.chatStore = new ChatStore(this.app, this.manifest.dir ?? '');
    await this.chatStore.load();

    this.aiService = new AiService(this.settings);
    this.pdfService = new PdfService(this.app);
    this.proxyManager = new ProxyManager(this.settings.baseUrl);

    this.setupPdfjsWorker();
    this.registerViews();
    this.addCommands();
    this.addRibbonIcons();
    this.addSettingTab(new PdfCanvasAiSettingTab(this.app, this));
    this.canvasInjector = new CanvasPdfInjector(this);
    this.canvasInjector.start();
    this.registerCanvasMenu();
    this.registerPdfIntercept();
    this.registerVaultEvents();

    // Start the local proxy only if opt-in via settings
    if (this.settings.proxyAutoStart && this.settings.provider === 'local-proxy') {
      this.proxyManager.ensureRunning().catch((e: unknown) => {
        console.error('PDF Canvas AI: proxyManager.ensureRunning error', e);
      });
    }

    console.log('PDF Canvas AI: loaded');
  }

  async onunload(): Promise<void> {
    this.canvasInjector.stop();
    this.annotationStore.destroy();
    await this.chatStore.flush();
    this.chatStore.destroy();
    this.proxyManager.stop();
    console.log('PDF Canvas AI: unloaded');
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.aiService?.updateSettings(this.settings);
  }

  // ─── pdfjs worker setup ────────────────────────────────────────────────────

  private setupPdfjsWorker(): void {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      // The worker file is copied alongside main.js by esbuild.config.mjs
      const workerUrl = adapter.getResourcePath(
        normalizePath(`${this.manifest.dir}/pdf.worker.min.js`),
      );
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    } else {
      console.warn('PDF Canvas AI: non-filesystem adapter, pdfjs worker may fail');
    }
  }

  // ─── Views ─────────────────────────────────────────────────────────────────

  private registerViews(): void {
    this.registerView(AI_SIDEBAR_VIEW_TYPE, (leaf) => new AiSidebarView(leaf, this));
    this.registerView(AI_CHAT_VIEW_TYPE, (leaf) => new AiChatView(leaf, this));
    this.registerView(PDF_VIEWER_VIEW_TYPE, (leaf) => new PdfViewerView(leaf, this));
  }

  // ─── Ribbon ────────────────────────────────────────────────────────────────

  private addRibbonIcons(): void {
    this.addRibbonIcon('bot', 'Open PDF Canvas AI sidebar', () => {
      this.activateAiSidebar().catch((e: unknown) => {
        console.error('PDF Canvas AI: activateAiSidebar error', e);
      });
    });

    this.addRibbonIcon('message-square', 'Open AI Chat', () => {
      this.activateAiChat().catch((e: unknown) => {
        console.error('PDF Canvas AI: activateAiChat error', e);
      });
    });

    this.addRibbonIcon('file-text', 'Open PDF Viewer', () => {
      this.activatePdfViewer().catch((e: unknown) => {
        console.error('PDF Canvas AI: activatePdfViewer error', e);
      });
    });
  }

  // ─── Commands ──────────────────────────────────────────────────────────────

  private addCommands(): void {
    this.addCommand({
      id: 'open-ai-sidebar',
      name: 'Open AI sidebar',
      callback: () => {
        this.activateAiSidebar().catch((e: unknown) => console.error(e));
      },
    });

    this.addCommand({
      id: 'open-ai-chat',
      name: 'Open AI chat (full window)',
      callback: () => {
        this.activateAiChat().catch((e: unknown) => console.error(e));
      },
    });

    this.addCommand({
      id: 'open-pdf-viewer',
      name: 'Open PDF viewer pane',
      callback: () => {
        this.activatePdfViewer().catch((e: unknown) => console.error(e));
      },
    });

    this.addCommand({
      id: 'open-selected-pdf',
      name: 'Open selected canvas PDF in viewer',
      callback: () => {
        this.openSelectedCanvasPdf().catch((e: unknown) => console.error(e));
      },
    });

    this.addCommand({
      id: 'ask-selected-pdfs',
      name: 'Ask Claude about selected canvas PDF(s)',
      callback: () => {
        this.askAboutPdfs('selected').catch((e: unknown) => console.error(e));
      },
    });

    this.addCommand({
      id: 'ask-all-canvas-pdfs',
      name: 'Ask Claude about all canvas PDFs',
      callback: () => {
        this.askAboutPdfs('all').catch((e: unknown) => console.error(e));
      },
    });
  }

  // ─── Canvas node context menu ──────────────────────────────────────────────

  private registerCanvasMenu(): void {
    // `canvas:node-menu` fires when the user right-clicks a canvas node.
    // It is undocumented but has been stable across community plugins since v1.4.
    // Cast workspace to any — the event name is not in Obsidian's public types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = this.app.workspace as any;
    const ref: EventRef = ws.on('canvas:node-menu', (menu: Menu, node: unknown) => {
      const file = this.resolveCanvasNodeFile(node);
      if (!file || file.extension !== 'pdf') return;

      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle('Open in PDF viewer')
          .setIcon('file-text')
          .onClick(() => {
            this.activatePdfViewer()
              .then(() => this.openFileInViewer(file))
              .catch((e: unknown) => console.error(e));
          }),
      );
      menu.addItem((item) =>
        item
          .setTitle('Ask AI about this PDF')
          .setIcon('bot')
          .onClick(() => {
            this.openFileInViewerAndAsk(file).catch((e: unknown) => console.error(e));
          }),
      );
    });
    this.registerEvent(ref);
  }

  /**
   * Extract a TFile from a canvas node object, handling all node shapes seen
   * across Obsidian versions:
   *   - `node.file` is a TFile object  (most versions, v1.4+)
   *   - `node.filePath` is a string    (older versions)
   *   - `node.file` is a string path   (some intermediate versions)
   *   - `node.getData().file` is a string (serialized canvas data shape)
   */
  private resolveCanvasNodeFile(node: unknown): TFile | null {
    if (!node || typeof node !== 'object') return null;
    const n = node as Record<string, unknown>;

    // Shape 1: node.file is already a TFile
    if (n.file instanceof TFile) return n.file;

    // Shape 2: node.filePath is a string
    if (typeof n.filePath === 'string') {
      const f = this.app.vault.getAbstractFileByPath(n.filePath);
      return f instanceof TFile ? f : null;
    }

    // Shape 3: node.file is a string path
    if (typeof n.file === 'string') {
      const f = this.app.vault.getAbstractFileByPath(n.file);
      return f instanceof TFile ? f : null;
    }

    // Shape 4: serialized canvas data via getData()
    if (typeof n.getData === 'function') {
      try {
        const data = (n.getData as () => Record<string, unknown>)();
        if (typeof data.file === 'string') {
          const f = this.app.vault.getAbstractFileByPath(data.file);
          return f instanceof TFile ? f : null;
        }
      } catch {
        // getData() failed — ignore
      }
    }

    return null;
  }

  // ─── PDF intercept: redirect native viewer to ours ─────────────────────────

  private originalPdfViewType: string | undefined;

  private registerPdfIntercept(): void {
    // Override the extension → view-type mapping so all PDF opens use our viewer.
    // viewRegistry is internal but widely used by community plugins (pdf++, excalidraw, etc.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = (this.app as any).viewRegistry;
    if (!registry?.typeByExtension) {
      console.warn('PDF Canvas AI: viewRegistry not found, PDF intercept unavailable');
      return;
    }

    this.originalPdfViewType = registry.typeByExtension['pdf'];
    registry.typeByExtension['pdf'] = PDF_VIEWER_VIEW_TYPE;

    // Restore on unload so disabling the plugin reverts to native behavior
    this.register(() => {
      if (this.originalPdfViewType !== undefined) {
        registry.typeByExtension['pdf'] = this.originalPdfViewType;
      }
    });
  }

  // ─── Vault events ──────────────────────────────────────────────────────────

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'pdf') {
          this.pdfService.invalidateFile(file.path);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'pdf') {
          this.annotationStore.renameFile(oldPath, file.path);
          this.pdfService.invalidateFile(oldPath);
        }
      }),
    );
  }

  // ─── View activation ───────────────────────────────────────────────────────

  async activateAiSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(AI_SIDEBAR_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: AI_SIDEBAR_VIEW_TYPE, active: true });
    const leaves = this.app.workspace.getLeavesOfType(AI_SIDEBAR_VIEW_TYPE);
    if (leaves.length > 0) this.app.workspace.revealLeaf(leaves[0]);
  }

  async activateAiChat(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: AI_CHAT_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async activatePdfViewer(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(PDF_VIEWER_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    // Open as a new tab (not a split — splits cause janky open-then-close behavior)
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: PDF_VIEWER_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async openFileInViewer(file: TFile, attempt = 0): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(PDF_VIEWER_VIEW_TYPE);
    const leaf = leaves[0];
    if (!leaf) {
      if (attempt >= 2) {
        new Notice('PDF Canvas AI: Could not open PDF viewer pane.');
        return;
      }
      await this.activatePdfViewer();
      return this.openFileInViewer(file, attempt + 1);
    }
    const view = leaf.view as PdfViewerView;
    await view.loadFile(file);
    this.app.workspace.revealLeaf(leaf);
  }

  getAiSidebarView(): AiSidebarView | null {
    const leaves = this.app.workspace.getLeavesOfType(AI_SIDEBAR_VIEW_TYPE);
    return leaves.length > 0 ? (leaves[0].view as AiSidebarView) : null;
  }

  /** Returns the canvas object from any open canvas leaf, or null. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getActiveCanvas(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const active = this.app.workspace.getActiveViewOfType(ItemView) as any;
    if (active?.getViewType?.() === 'canvas' && active.canvas) {
      return active.canvas;
    }
    const canvasLeaves = this.app.workspace.getLeavesOfType('canvas');
    for (const leaf of canvasLeaves) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = leaf.view as any;
      if (view?.canvas) return view.canvas;
    }
    return null;
  }

  /** Returns the file currently open in the standalone PDF viewer, if any. */
  getViewerCurrentFile(): TFile | null {
    const leaves = this.app.workspace.getLeavesOfType(PDF_VIEWER_VIEW_TYPE);
    if (leaves.length === 0) return null;
    const view = leaves[0].view;
    if (view instanceof PdfViewerView) {
      return view.getCurrentFile();
    }
    return null;
  }

  // ─── PDF context gathering ─────────────────────────────────────────────────

  async gatherPdfContext(scope: 'selected' | 'all'): Promise<string> {
    let nodes =
      scope === 'selected' ? getSelectedPdfNodes(this.app) : getAllCanvasPdfNodes(this.app);

    // If selection yielded nothing, fall back to viewer's open file
    if (nodes.length === 0) {
      const viewerLeaves = this.app.workspace.getLeavesOfType(PDF_VIEWER_VIEW_TYPE);
      if (viewerLeaves.length > 0) {
        const view = viewerLeaves[0].view;
        if (view instanceof PdfViewerView) {
          const file = view.getCurrentFile();
          if (file) nodes = [{ file, node: null }];
        }
      }
    }

    if (nodes.length === 0) {
      return '[No PDF files found. Open a canvas with PDF nodes, or open a PDF in the viewer.]';
    }

    const notice = new Notice(`PDF Canvas AI: Extracting text from ${nodes.length} PDF(s)…`, 0);
    try {
      const parts = await Promise.all(
        nodes.map(async ({ file }) => {
          const text = await this.pdfService.extractText(file);
          return `=== ${file.name} ===\n\n${text}`;
        }),
      );
      return parts.join('\n\n---\n\n');
    } finally {
      notice.hide();
    }
  }

  /**
   * Gather full canvas context: PDFs, text cards, file embeds, connections.
   * Gives Claude a holistic understanding of the entire canvas workspace.
   */
  async gatherCanvasContext(): Promise<string> {
    const canvas = this.getActiveCanvas();
    if (!canvas) {
      return '[No active canvas found. Open a canvas to use full canvas context.]';
    }
    const parts: string[] = [];

    // Collect all node content
    if (canvas.nodes) {
      const notice = new Notice('PDF Canvas AI: Reading canvas content...', 0);
      try {
        for (const node of canvas.nodes.values()) {
          const nodeData = typeof node.getData === 'function' ? node.getData() : node;
          const nodeType = nodeData.type ?? 'unknown';

          if (nodeType === 'text' && nodeData.text) {
            parts.push(`[Text Card]\n${nodeData.text}`);
          } else if (nodeType === 'file' && node.file instanceof TFile) {
            if (node.file.extension === 'pdf') {
              try {
                const text = await this.pdfService.extractText(node.file);
                parts.push(`[PDF: ${node.file.name}]\n${text}`);
              } catch {
                parts.push(`[PDF: ${node.file.name}] (text extraction failed)`);
              }
            } else if (node.file.extension === 'md') {
              try {
                const content = await this.app.vault.cachedRead(node.file);
                parts.push(`[Note: ${node.file.name}]\n${content}`);
              } catch {
                parts.push(`[Note: ${node.file.name}] (read failed)`);
              }
            } else {
              parts.push(`[File: ${node.file.name}]`);
            }
          } else if (nodeType === 'link' && nodeData.url) {
            parts.push(`[Link: ${nodeData.url}]`);
          } else if (nodeType === 'group') {
            const label = nodeData.label || '(unnamed group)';
            parts.push(`[Group: ${label}]`);
          }
        }
      } finally {
        notice.hide();
      }
    }

    // Collect connections/edges for spatial context
    const edges = canvas.edges ?? canvas.data?.edges;
    if (edges && (edges instanceof Map || Array.isArray(edges))) {
      const edgeList: string[] = [];
      const iter = edges instanceof Map ? edges.values() : edges;
      for (const edge of iter) {
        const data = typeof edge.getData === 'function' ? edge.getData() : edge;
        if (data.fromNode && data.toNode) {
          edgeList.push(`${data.fromNode} -> ${data.toNode}`);
        }
      }
      if (edgeList.length > 0) {
        parts.push(`[Connections]\n${edgeList.join('\n')}`);
      }
    }

    if (parts.length === 0) {
      return '[Canvas is empty.]';
    }

    return parts.join('\n\n---\n\n');
  }

  // ─── Compound actions ──────────────────────────────────────────────────────

  private async openSelectedCanvasPdf(): Promise<void> {
    const nodes = getSelectedPdfNodes(this.app);
    if (nodes.length === 0) {
      new Notice('PDF Canvas AI: No PDF node selected on canvas.');
      return;
    }
    await this.activatePdfViewer();
    await this.openFileInViewer(nodes[0].file);
  }

  async askAboutPdfs(_scope: 'selected' | 'all'): Promise<void> {
    await this.activateAiSidebar();
    const view = this.getAiSidebarView();
    if (view) view.setContextScope('pdf');
    new Notice('PDF Canvas AI: Context set. Type your question in the sidebar.');
  }

  private async openFileInViewerAndAsk(file: TFile): Promise<void> {
    await this.activatePdfViewer();
    await this.openFileInViewer(file);
    await this.activateAiSidebar();
    const view = this.getAiSidebarView();
    if (view) {
      view.setCurrentPdf(file);
      view.setContextScope('pdf');
    }
  }

  /**
   * Gather vault-wide context by searching for files matching the query.
   * Uses a simple keyword search across vault file names and markdown content.
   */
  async gatherVaultContext(query: string): Promise<string> {
    const parts: string[] = [];
    const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (keywords.length === 0) {
      return '[No search keywords found in your question.]';
    }

    const allFiles = this.app.vault.getFiles();
    const matchingFiles: TFile[] = [];

    // Score files by keyword matches in name/path
    for (const file of allFiles) {
      if (file.extension !== 'md' && file.extension !== 'pdf') continue;
      const pathLower = file.path.toLowerCase();
      const score = keywords.filter((k) => pathLower.includes(k)).length;
      if (score > 0) matchingFiles.push(file);
    }

    // Also search markdown file content for keyword matches (limit search)
    const mdFiles = allFiles.filter((f) => f.extension === 'md');
    const contentSearchLimit = Math.min(mdFiles.length, 200);
    for (let i = 0; i < contentSearchLimit; i++) {
      const file = mdFiles[i];
      if (matchingFiles.includes(file)) continue;
      try {
        const content = await this.app.vault.cachedRead(file);
        const contentLower = content.toLowerCase();
        const score = keywords.filter((k) => contentLower.includes(k)).length;
        if (score >= Math.max(1, Math.floor(keywords.length / 2))) {
          matchingFiles.push(file);
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Cap results
    const filesToInclude = matchingFiles.slice(0, 10);

    const notice = new Notice(`PDF Canvas AI: Reading ${filesToInclude.length} vault files\u2026`, 0);
    try {
      for (const file of filesToInclude) {
        try {
          if (file.extension === 'pdf') {
            const text = await this.pdfService.extractText(file);
            parts.push(`[PDF: ${file.path}]\n${text}`);
          } else {
            const content = await this.app.vault.cachedRead(file);
            parts.push(`[Note: ${file.path}]\n${content}`);
          }
        } catch {
          parts.push(`[${file.path}] (read failed)`);
        }
      }
    } finally {
      notice.hide();
    }

    if (parts.length === 0) {
      return '[No matching files found in vault.]';
    }

    return parts.join('\n\n---\n\n');
  }
}
