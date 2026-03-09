import type { WorkspaceLeaf } from 'obsidian';
import type PdfCanvasAiPlugin from '../main';
import { AiSidebarView } from './AiSidebarView';

export const AI_CHAT_VIEW_TYPE = 'pdf-tools-chat';

/**
 * Full-size chat view that opens in the main editor area.
 * Same functionality as AiSidebarView, just wider.
 */
export class AiChatView extends AiSidebarView {
  constructor(leaf: WorkspaceLeaf, plugin: PdfCanvasAiPlugin) {
    super(leaf, plugin);
  }

  getViewType(): string {
    return AI_CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'AI Chat';
  }

  getIcon(): string {
    return 'message-square';
  }
}
