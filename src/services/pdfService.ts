import type { App } from 'obsidian';
import type { TFile } from 'obsidian';
import * as pdfjsLib from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

/**
 * Extracts plain text from a PDF vault file for use as AI context.
 * Caches results per file path; call invalidateFile() on vault modify events.
 */
export class PdfService {
  private app: App;
  private cache = new Map<string, string>();

  constructor(app: App) {
    this.app = app;
  }

  async extractText(file: TFile): Promise<string> {
    const cached = this.cache.get(file.path);
    if (cached !== undefined) return cached;

    let result: string;
    try {
      const buffer = await this.app.vault.readBinary(file);
      const data = new Uint8Array(buffer);
      const pdf = await pdfjsLib.getDocument({ data }).promise;
      try {
        const parts: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items
            .filter((item): item is TextItem => 'str' in item)
            .map((item) => item.str)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (pageText) {
            parts.push(`[Page ${i}]\n${pageText}`);
          }
        }
        result = parts.join('\n\n');
      } finally {
        await pdf.destroy();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('PDF Tools — extractText error:', err);
      result = `[Error extracting text from ${file.name}: ${msg}]`;
    }

    this.cache.set(file.path, result);
    return result;
  }

  invalidateFile(path: string): void {
    this.cache.delete(path);
  }

  clearCache(): void {
    this.cache.clear();
  }
}
