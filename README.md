# PDF Tools

Obsidian plugin that turns your vault into a research workspace. Read and annotate PDFs with Zotero-style highlights, chat with AI about your documents, and organize everything on Obsidian's spatial canvas.

## Features

### PDF Reader
- **Dedicated PDF viewer** with pdfjs-dist text layer — selectable, searchable text
- **Zotero-style highlights** — select text, pick a color, highlights persist across sessions
- **Color labels** — assign meanings to each highlight color (e.g. yellow = "Important", blue = "Definition") and filter annotations by color
- **Annotation library** — left sidebar lists all PDFs and their annotations, grouped by page
- **Click-to-navigate** — click an annotation card to jump to that page
- **Notes on highlights** — add freeform notes to any highlight
- **Table of contents** — collapsible outline sidebar for PDFs with bookmarks
- **Built-in dictionary** — look up words with an embedded 82k-word WordNet dictionary (auto-downloaded on first use, with online API fallback)
- **Zoom controls** — zoom in/out, fit to width
- **Search** — full-text search within PDF (Ctrl/Cmd+F)
- **Replaces native viewer** — clicking any PDF in the file explorer opens in this viewer

### AI Chat
- **Multi-provider** — OpenAI, Anthropic (Claude), or any OpenAI-compatible API (Ollama, LM Studio, local proxies)
- **Auto-context** — sidebar detects the active file (PDF, markdown, canvas) and includes it as context
- **@ file mentions** — type `@` in the chat input to attach any vault file as context
- **Vault tools** — AI can search your vault, read files, list directories, and inspect canvas items
- **Streaming responses** — token-by-token output with markdown rendering
- **Chat persistence** — conversations saved across sessions, chat history browser
- **Compaction** — long conversations are automatically summarized to stay within context limits
- **Full-window chat** — open AI chat as a full editor tab for more space

### Canvas Integration
- **Right-click menu** — "Open in PDF viewer", "Ask AI", "Spread pages", and "Extract current page" on canvas PDF nodes
- **Inline PDF rendering** — PDF nodes on canvas render with text selection and highlights
- **Interactive mode** — double-click a canvas PDF to enter interactive mode (scroll, select text); click outside to exit and resume node dragging
- **Spread pages** — explode a multi-page PDF into individual page nodes on the canvas (choose down or right direction)
- **Canvas context** — AI can read all items on the active canvas (text cards, files, connections)

## Installation

### From Community Plugins (recommended)

1. Open **Settings → Community plugins → Browse**
2. Search for "PDF Tools"
3. Click **Install**, then **Enable**

### Manual Installation

```bash
git clone https://github.com/voidash/obsidian-pdf-tools.git
cd obsidian-pdf-tools
npm install
npm run build
```

Copy `main.js`, `styles.css`, and `manifest.json` into your vault at `.obsidian/plugins/pdf-tools/`.

## Configuration

**Settings → PDF Tools**

| Setting | Default | Description |
|---|---|---|
| Enable AI | On | Turn off to use as a pure PDF reader/annotator |
| AI Provider | OpenAI | 15 providers: OpenAI, Anthropic, Gemini, DeepSeek, Groq, xAI, Mistral, OpenRouter, Together AI, Fireworks AI, Cerebras, Ollama, LM Studio, Local Proxy, Custom |
| API Key | *(empty)* | Your API key (leave empty for local providers) |
| Model | `gpt-4o` | Model identifier (auto-filled per provider) |
| API Base URL | `https://api.openai.com/v1` | Endpoint URL (auto-filled per provider) |
| Max context chars | `80000` | Document text truncation limit |
| System prompt | *(built-in)* | AI instructions |
| Default zoom | `1.5` | Initial zoom level for PDF viewer (0.5–4.0) |
| Default highlight color | Yellow | Pre-selected highlight color |
| Resume reading position | On | Scroll to last read page on open |
| Export format | Callout | Annotation export: callout blocks or plain markdown |
| Dictionary source | Auto | Local WordNet, online API, or auto (local + fallback) |
| Highlight color labels | Important, Key Point, Definition, Question, Disagree | Meaning assigned to each color |

### Supported Providers

| Provider | Base URL | Default Model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Anthropic | `https://api.anthropic.com/v1` | `claude-sonnet-4-20250514` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-pro` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| xAI (Grok) | `https://api.x.ai/v1` | `grok-3` |
| Mistral | `https://api.mistral.ai/v1` | `mistral-large-latest` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |
| Together AI | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/llama-v3p3-70b-instruct` |
| Cerebras | `https://api.cerebras.ai/v1` | `llama-3.3-70b` |
| Ollama | `http://localhost:11434/v1` | `llama3` |
| LM Studio | `http://localhost:1234/v1` | *(your model)* |
| Local Proxy | `http://localhost:3456/v1` | `claude-opus-4` |
| Custom | *(your endpoint)* | *(your model)* |

## Commands

| Command | Description |
|---|---|
| Open AI sidebar | Chat panel in the right sidebar |
| Open AI chat (full window) | Full-size chat as an editor tab |
| Open PDF viewer pane | Dedicated PDF viewer |
| Open selected canvas PDF in viewer | Load selected canvas node |
| Ask Claude about selected canvas PDF(s) | Set context + open sidebar |
| Ask Claude about all canvas PDFs | Set context + open sidebar |

## Development

```bash
npm run dev   # watch mode — rebuilds on save
npm run build # production build
```

## License

MIT
