# PDF Canvas AI

Obsidian plugin that turns your vault into a research workspace. Read and annotate PDFs with Zotero-style highlights, chat with AI about your documents, and organize everything on Obsidian's spatial canvas.

## Features

### PDF Reader
- **Dedicated PDF viewer** with pdfjs-dist text layer — selectable, searchable text
- **Zotero-style highlights** — select text, pick a color, highlights persist across sessions
- **Annotation library** — left sidebar lists all PDFs and their annotations, grouped by page
- **Click-to-navigate** — click an annotation card to jump to that page
- **Notes on highlights** — add freeform notes to any highlight
- **Zoom controls** — zoom in/out, fit to width
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
- **Right-click menu** — "Open in PDF viewer" and "Ask AI" on canvas PDF nodes
- **Inline PDF rendering** — PDF nodes on canvas render with text selection and highlights
- **Canvas context** — AI can read all items on the active canvas (text cards, files, connections)

## Installation

### From Community Plugins (recommended)

1. Open **Settings → Community plugins → Browse**
2. Search for "PDF Canvas AI"
3. Click **Install**, then **Enable**

### Manual Installation

```bash
git clone https://github.com/voidash/obsidian-pdf-canvas-ai.git
cd obsidian-pdf-canvas-ai
npm install
npm run build
```

Copy `main.js`, `styles.css`, `manifest.json`, and `pdf.worker.min.js` into your vault at `.obsidian/plugins/pdf-canvas-ai/`.

## Configuration

**Settings → PDF Canvas AI**

| Setting | Default | Description |
|---|---|---|
| AI Provider | OpenAI | OpenAI, Anthropic, Local Proxy, or Custom |
| API Key | *(empty)* | Your API key (leave empty for local proxies) |
| Model | `gpt-4o` | Model identifier |
| API Base URL | `https://api.openai.com/v1` | Endpoint URL |
| Max context chars | `80000` | Document text truncation limit |
| System prompt | *(built-in)* | AI instructions |

### Provider Examples

| Provider | Base URL | Model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Anthropic | `https://api.anthropic.com/v1` | `claude-sonnet-4-20250514` |
| Ollama | `http://localhost:11434/v1` | `llama3` |
| LM Studio | `http://localhost:1234/v1` | *(your model)* |

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
