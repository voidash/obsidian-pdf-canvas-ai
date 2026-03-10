import { Notice } from 'obsidian';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';

/**
 * Manages the claude-max-api-proxy subprocess.
 *
 * On ensureRunning():
 *  1. Check if the proxy is already answering on its configured port.
 *  2. If not, spawn it using a login shell so the user's PATH is available.
 *  3. Wait up to 8 s for it to become ready, then notify.
 *
 * stop() kills the subprocess on plugin unload.
 */
export class ProxyManager {
  private process: ChildProcess | null = null;
  private startAttempted = false;

  constructor(private readonly baseUrl: string) {}

  async ensureRunning(): Promise<void> {
    if (await this.isRunning()) return;
    if (this.startAttempted) return;
    this.startAttempted = true;
    await this.start();
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async isRunning(): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      // Using fetch because this checks a local subprocess health endpoint;
      // Obsidian's requestUrl lacks AbortController signal support.
      const res = await fetch(this.baseUrl, { signal: ctrl.signal });
      // Any HTTP response (even 404/401) means the server is up
      return res.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async start(): Promise<void> {
    const notice = new Notice('PDF Tools: Starting AI proxy…', 0);

    // Use a login shell so the user's PATH (e.g. ~/.npm-global/bin, /usr/local/bin)
    // is available even when Obsidian is launched from the macOS dock.
    const shell = process.env.SHELL ?? '/bin/zsh';

    // Strip CLAUDECODE so the proxy's spawned `claude` subprocess does not
    // see it and refuse to run (Claude CLI forbids nested sessions).
    const env = { ...process.env };
    delete env['CLAUDECODE'];

    // The package is "claude-max-api-proxy" but the binary it installs is "claude-max-api"
    this.process = spawn(shell, ['-l', '-c', 'claude-max-api'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env,
    });

    this.process.stdout?.on('data', (d: Buffer) => {
      console.debug('[proxy]', d.toString().trimEnd());
    });

    this.process.stderr?.on('data', (d: Buffer) => {
      console.debug('[proxy stderr]', d.toString().trimEnd());
    });

    this.process.on('error', (err) => {
      notice.hide();
      this.process = null;
      new Notice(
        `PDF Tools: Could not start proxy — ${err.message}\n` +
          'Install with: npm install -g claude-max-api-proxy  (binary: claude-max-api)',
        10000,
      );
    });

    this.process.on('exit', (code) => {
      console.debug(`PDF Tools: proxy exited (code ${code})`);
      this.process = null;
    });

    const ready = await this.waitUntilReady(8000);
    notice.hide();

    if (ready) {
      new Notice('PDF Tools: AI proxy ready.', 2000);
    } else if (this.process) {
      // Still running but not answering — might need more time; don't kill it.
      new Notice(
        'PDF Tools: Proxy is starting slowly — AI will be available shortly.',
        4000,
      );
    }
    // If this.process is null here, the 'error' handler already notified the user.
  }

  private async waitUntilReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 600));
      if (!this.process) return false; // process exited with error
      if (await this.isRunning()) return true;
    }
    return false;
  }

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }
}
