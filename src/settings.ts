import { App, PluginSettingTab, Setting } from 'obsidian';
import type PdfCanvasAiPlugin from './main';

export type AiProvider = 'local-proxy' | 'openai' | 'anthropic' | 'custom';

export interface ProviderConfig {
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface PluginSettings {
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxContextChars: number;
  systemPrompt: string;
  proxyAutoStart: boolean;
}

const PROVIDER_DEFAULTS: Record<AiProvider, Omit<ProviderConfig, 'provider'>> = {
  'local-proxy': {
    baseUrl: 'http://localhost:3456/v1',
    apiKey: '',
    model: 'claude-opus-4',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: '',
    model: 'claude-sonnet-4-20250514',
  },
  custom: {
    baseUrl: '',
    apiKey: '',
    model: '',
  },
};

export const DEFAULT_SETTINGS: PluginSettings = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o',
  maxContextChars: 80000,
  proxyAutoStart: false,
  systemPrompt:
    'You are a helpful assistant that analyzes PDF documents. ' +
    'When PDF content is provided as context, analyze it carefully and answer questions about it. ' +
    'Be concise and precise. When quoting from the document, use block quotes.',
};

const PROVIDER_LABELS: Record<AiProvider, string> = {
  'local-proxy': 'Local Proxy (claude-max-api-proxy)',
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude API)',
  custom: 'Custom OpenAI-compatible',
};

export class PdfCanvasAiSettingTab extends PluginSettingTab {
  plugin: PdfCanvasAiPlugin;

  constructor(app: App, plugin: PdfCanvasAiPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'PDF Canvas AI' });

    // ── Provider selector ──
    new Setting(containerEl)
      .setName('AI Provider')
      .setDesc('Select how to connect to an AI model.')
      .addDropdown((dd) => {
        for (const [key, label] of Object.entries(PROVIDER_LABELS)) {
          dd.addOption(key, label);
        }
        dd.setValue(this.plugin.settings.provider);
        dd.onChange(async (value) => {
          const provider = value as AiProvider;
          this.plugin.settings.provider = provider;
          // Fill in defaults for the new provider, but don't overwrite
          // if the user previously configured this provider
          const defaults = PROVIDER_DEFAULTS[provider];
          if (!this.plugin.settings.baseUrl || this.plugin.settings.baseUrl === PROVIDER_DEFAULTS[this.previousProvider() ?? 'local-proxy'].baseUrl) {
            this.plugin.settings.baseUrl = defaults.baseUrl;
          }
          if (!this.plugin.settings.model || this.plugin.settings.model === PROVIDER_DEFAULTS[this.previousProvider() ?? 'local-proxy'].model) {
            this.plugin.settings.model = defaults.model;
          }
          await this.plugin.saveSettings();
          this.display(); // re-render to update descriptions
        });
      });

    // ── API key ──
    const provider = this.plugin.settings.provider;
    const keyDesc = provider === 'local-proxy'
      ? 'Leave empty — the local proxy handles auth via your Claude Max subscription.'
      : `API key for ${PROVIDER_LABELS[provider]}.`;

    new Setting(containerEl)
      .setName('API Key')
      .setDesc(keyDesc)
      .addText((text) => {
        text
          .setPlaceholder(provider === 'local-proxy' ? '(leave empty)' : 'sk-...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
      });

    // ── Model ──
    const modelDefault = PROVIDER_DEFAULTS[provider].model;
    new Setting(containerEl)
      .setName('Model')
      .setDesc(`Model identifier. Default for this provider: ${modelDefault || '(none)'}`)
      .addText((text) =>
        text
          .setPlaceholder(modelDefault)
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // ── Base URL ──
    new Setting(containerEl)
      .setName('API Base URL')
      .setDesc('Override the endpoint URL. Change only if you know what you\'re doing.')
      .addText((text) =>
        text
          .setPlaceholder(PROVIDER_DEFAULTS[provider].baseUrl)
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // ── Max context ──
    new Setting(containerEl)
      .setName('Max context characters')
      .setDesc('Maximum characters of document text sent as context. Large documents will be truncated.')
      .addText((text) =>
        text
          .setPlaceholder('80000')
          .setValue(String(this.plugin.settings.maxContextChars))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.maxContextChars = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    // ── Proxy auto-start (only relevant for local-proxy provider) ──
    if (provider === 'local-proxy') {
      new Setting(containerEl)
        .setName('Auto-start local proxy')
        .setDesc(
          'Automatically start claude-max-api-proxy when the plugin loads. ' +
          'Requires claude-max-api to be installed globally (npm install -g claude-max-api-proxy).',
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.proxyAutoStart)
            .onChange(async (value) => {
              this.plugin.settings.proxyAutoStart = value;
              await this.plugin.saveSettings();
            }),
        );
    }

    // ── System prompt ──
    new Setting(containerEl)
      .setName('System prompt')
      .setDesc('Instructions sent to the AI before every conversation.')
      .addTextArea((text) => {
        text
          .setPlaceholder('You are a helpful assistant...')
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 5;
        text.inputEl.style.width = '100%';
      });
  }

  /** Returns the provider before the current render, for detecting default swaps. */
  private previousProvider(): AiProvider | null {
    // We rely on the setting already being saved before display() is called again.
    // This is used only for the heuristic of whether to swap defaults.
    return this.plugin.settings.provider;
  }
}
