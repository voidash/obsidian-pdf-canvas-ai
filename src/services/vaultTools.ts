import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { PdfService } from './pdfService';

/**
 * Tool definitions for OpenAI-compatible function calling.
 * These let the AI actively explore the vault instead of receiving a passive blob.
 */
export const VAULT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_vault',
      description:
        'Search for text across files in the Obsidian vault. ' +
        'Returns matching lines with file paths. Use this to find relevant information.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Text to search for (case-insensitive substring match)',
          },
          extension: {
            type: 'string',
            description: 'Optional file extension filter: "md", "pdf", "txt", etc.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description:
        'Read the full content of a file from the vault. ' +
        'For PDFs, extracts all text content. For markdown/text files, returns raw content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path (e.g. "notes/my-note.md" or "papers/paper.pdf")',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description:
        'List files in the vault. Returns file paths, optionally filtered by directory or extension.',
      parameters: {
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            description: 'Optional subdirectory to list (relative to vault root). Omit for entire vault.',
          },
          extension: {
            type: 'string',
            description: 'Optional file extension filter: "md", "pdf", "canvas", etc.',
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_canvas_items',
      description:
        'Get a structured list of all items on the currently open Obsidian canvas: ' +
        'text cards, file nodes, links, groups, and connections between them.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

/**
 * Executes vault tool calls. Needs access to App and PdfService.
 */
export class VaultToolExecutor {
  private app: App;
  private pdfService: PdfService;
  private getCanvas: () => unknown;

  constructor(
    app: App,
    pdfService: PdfService,
    getCanvas: () => unknown,
  ) {
    this.app = app;
    this.pdfService = pdfService;
    this.getCanvas = getCanvas;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'search_vault':
        return this.searchVault(
          args.query as string,
          args.extension as string | undefined,
        );
      case 'read_file':
        return this.readFile(args.path as string);
      case 'list_files':
        return this.listFiles(
          args.directory as string | undefined,
          args.extension as string | undefined,
        );
      case 'get_canvas_items':
        return this.getCanvasItems();
      default:
        return `Unknown tool: ${name}`;
    }
  }

  private async searchVault(query: string, extension?: string): Promise<string> {
    if (!query) return 'Error: query is required';

    const queryLower = query.toLowerCase();
    const allFiles = this.app.vault.getFiles();
    const results: string[] = [];
    const MAX_RESULTS = 20;
    const MAX_FILES_TO_SEARCH = 500;

    let filesSearched = 0;

    for (const file of allFiles) {
      if (filesSearched >= MAX_FILES_TO_SEARCH) break;
      if (results.length >= MAX_RESULTS) break;
      if (extension && file.extension !== extension) continue;

      // Search by filename first
      if (file.path.toLowerCase().includes(queryLower)) {
        results.push(`[File match] ${file.path}`);
        if (results.length >= MAX_RESULTS) break;
      }

      // Search content for text files
      if (file.extension === 'md' || file.extension === 'txt') {
        filesSearched++;
        try {
          const content = await this.app.vault.cachedRead(file);
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(queryLower)) {
              const lineNum = i + 1;
              const snippet = lines[i].trim().slice(0, 200);
              results.push(`${file.path}:${lineNum}: ${snippet}`);
              if (results.length >= MAX_RESULTS) break;
            }
          }
        } catch {
          // Skip unreadable
        }
      }

      // Search PDF text
      if (file.extension === 'pdf') {
        filesSearched++;
        try {
          const text = await this.pdfService.extractText(file);
          if (text.toLowerCase().includes(queryLower)) {
            // Find the relevant passage
            const idx = text.toLowerCase().indexOf(queryLower);
            const start = Math.max(0, idx - 80);
            const end = Math.min(text.length, idx + query.length + 80);
            const snippet = text.slice(start, end).replace(/\n/g, ' ').trim();
            results.push(`${file.path}: ...${snippet}...`);
          }
        } catch {
          // Skip
        }
      }
    }

    if (results.length === 0) {
      return `No results found for "${query}"${extension ? ` in .${extension} files` : ''}.`;
    }

    return results.join('\n');
  }

  private async readFile(path: string): Promise<string> {
    if (!path) return 'Error: path is required';

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      return `File not found: ${path}`;
    }
    if (!(file instanceof TFile)) {
      return `Not a file (may be a folder): ${path}`;
    }

    const tfile = file;

    if (tfile.extension === 'pdf') {
      return this.pdfService.extractText(tfile);
    }

    try {
      const content = await this.app.vault.cachedRead(tfile);
      // Cap at 50k chars to avoid blowing up context
      if (content.length > 50000) {
        return content.slice(0, 50000) + '\n\n[...truncated at 50,000 characters]';
      }
      return content;
    } catch (err) {
      return `Error reading ${path}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private listFiles(directory?: string, extension?: string): string {
    const allFiles = this.app.vault.getFiles();
    const filtered: string[] = [];

    for (const file of allFiles) {
      if (directory && !file.path.startsWith(directory)) continue;
      if (extension && file.extension !== extension) continue;
      filtered.push(file.path);
    }

    filtered.sort();

    if (filtered.length === 0) {
      return `No files found${directory ? ` in ${directory}` : ''}${extension ? ` with extension .${extension}` : ''}.`;
    }

    // Cap listing
    if (filtered.length > 100) {
      return filtered.slice(0, 100).join('\n') + `\n\n[...${filtered.length - 100} more files]`;
    }

    return filtered.join('\n');
  }

  private getCanvasItems(): string {
    const raw = this.getCanvas();
    if (!raw) {
      return 'No canvas is currently open.';
    }

    // Narrow from unknown to a structural type for the internal canvas API
    const canvas = raw as {
      nodes?: Map<string, Record<string, unknown>>;
      edges?: Map<string, Record<string, unknown>> | Record<string, unknown>[];
      data?: { edges?: Map<string, Record<string, unknown>> | Record<string, unknown>[] };
    };

    const items: string[] = [];

    if (canvas.nodes) {
      for (const node of canvas.nodes.values()) {
        const data = typeof node.getData === 'function'
          ? (node.getData as () => Record<string, unknown>)()
          : node;
        const nodeType = (data.type as string) ?? 'unknown';
        const id = (data.id as string) ?? '?';

        if (nodeType === 'text') {
          const text = ((data.text as string) ?? '').slice(0, 200);
          items.push(`[Text Card id=${id}] ${text}${(data.text as string)?.length > 200 ? '...' : ''}`);
        } else if (nodeType === 'file') {
          const filePath = typeof data.file === 'string'
            ? data.file
            : ((node.file as { path?: string })?.path ?? '?');
          items.push(`[File Node id=${id}] ${filePath}`);
        } else if (nodeType === 'link') {
          items.push(`[Link id=${id}] ${(data.url as string) ?? '?'}`);
        } else if (nodeType === 'group') {
          items.push(`[Group id=${id}] ${(data.label as string) || '(unnamed)'}`);
        } else {
          items.push(`[${nodeType} id=${id}]`);
        }
      }
    }

    // Edges
    const edges = canvas.edges ?? canvas.data?.edges;
    if (edges && (edges instanceof Map || Array.isArray(edges))) {
      const iter = edges instanceof Map ? edges.values() : edges;
      for (const edge of iter) {
        const data = typeof edge.getData === 'function'
          ? (edge.getData as () => Record<string, unknown>)()
          : edge;
        if (data.fromNode && data.toNode) {
          const label = data.label ? ` "${data.label}"` : '';
          items.push(`[Connection] ${data.fromNode} -> ${data.toNode}${label}`);
        }
      }
    }

    if (items.length === 0) {
      return 'Canvas is empty.';
    }

    return items.join('\n');
  }
}
