import { normalizePath } from 'obsidian';
import type { App } from 'obsidian';
import { nanoid } from 'nanoid';
import type { ChatMessage } from '../services/aiService';

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** AI-generated summary of older messages (compaction). */
  compactedSummary?: string;
  /** How many messages (from the start) the summary covers. */
  compactedCount?: number;
}

interface ChatData {
  version: 1;
  conversations: Conversation[];
  activeConversationId: string | null;
}

const EMPTY_DATA: ChatData = { version: 1, conversations: [], activeConversationId: null };

export class ChatStore {
  private app: App;
  private filePath: string;
  private data: ChatData = { ...EMPTY_DATA, conversations: [] };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, pluginDir: string) {
    this.app = app;
    this.filePath = normalizePath(`${pluginDir}/conversations.json`);
  }

  async load(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.filePath)) {
        const raw = await adapter.read(this.filePath);
        const parsed = JSON.parse(raw);
        if (parsed?.version === 1 && Array.isArray(parsed.conversations)) {
          this.data = parsed as ChatData;
        }
      }
    } catch (e) {
      console.error('PDF Tools: failed to load conversations', e);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.app.vault.adapter
        .write(this.filePath, JSON.stringify(this.data, null, 2))
        .catch((e: unknown) => {
          console.error('PDF Tools: conversation save failed', e);
        });
    }, 500);
  }

  /** Force immediate save (e.g. on plugin unload). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await this.app.vault.adapter.write(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('PDF Tools: conversation flush failed', e);
    }
  }

  destroy(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  getAll(): Conversation[] {
    return this.data.conversations;
  }

  get(id: string): Conversation | undefined {
    return this.data.conversations.find((c) => c.id === id);
  }

  getActiveId(): string | null {
    // Verify the active ID still exists
    if (this.data.activeConversationId) {
      if (!this.get(this.data.activeConversationId)) {
        this.data.activeConversationId = null;
      }
    }
    return this.data.activeConversationId;
  }

  setActiveId(id: string | null): void {
    this.data.activeConversationId = id;
    this.scheduleSave();
  }

  // ─── Mutations ────────────────────────────────────────────────────────────

  create(title?: string): Conversation {
    const conv: Conversation = {
      id: nanoid(),
      title: title ?? 'New conversation',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.data.conversations.unshift(conv);
    this.data.activeConversationId = conv.id;
    this.scheduleSave();
    return conv;
  }

  delete(id: string): void {
    this.data.conversations = this.data.conversations.filter((c) => c.id !== id);
    if (this.data.activeConversationId === id) {
      this.data.activeConversationId =
        this.data.conversations.length > 0 ? this.data.conversations[0].id : null;
    }
    this.scheduleSave();
  }

  addMessage(conversationId: string, message: ChatMessage): void {
    const conv = this.get(conversationId);
    if (!conv) return;
    conv.messages.push(message);
    conv.updatedAt = Date.now();

    // Auto-title from first user message
    if (conv.title === 'New conversation' && message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : '';
      conv.title = text.slice(0, 60) + (text.length > 60 ? '\u2026' : '');
    }

    this.scheduleSave();
  }

  setCompaction(conversationId: string, summary: string, compactedCount: number): void {
    const conv = this.get(conversationId);
    if (!conv) return;
    conv.compactedSummary = summary;
    conv.compactedCount = compactedCount;
    conv.updatedAt = Date.now();
    this.scheduleSave();
  }
}
