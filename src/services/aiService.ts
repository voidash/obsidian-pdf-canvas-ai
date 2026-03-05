import OpenAI from 'openai';
import type { PluginSettings } from '../settings';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ToolCallEvent {
  name: string;
  args: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolDefinition = any;

export interface StreamOptions {
  tools?: ToolDefinition[];
  onToolCall?: (event: ToolCallEvent) => void;
  executeToolCall?: (name: string, args: Record<string, unknown>) => Promise<string>;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

const MAX_TOOL_ROUNDS = 6;

export class AiService {
  private client: OpenAI;
  private settings: PluginSettings;

  constructor(settings: PluginSettings) {
    this.settings = settings;
    this.client = this.createClient();
  }

  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
    this.client = this.createClient();
  }

  private createClient(): OpenAI {
    const provider = this.settings.provider;
    const isAnthropic = provider === 'anthropic';

    return new OpenAI({
      apiKey: this.settings.apiKey || 'dummy',
      baseURL: this.settings.baseUrl,
      dangerouslyAllowBrowser: true,
      ...(isAnthropic
        ? {
            defaultHeaders: {
              'x-api-key': this.settings.apiKey,
              'anthropic-version': '2023-06-01',
              'anthropic-dangerous-direct-browser-access': 'true',
            },
          }
        : {}),
      fetch: (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.headers) {
          const headers = new Headers(init.headers as HeadersInit);
          for (const key of [...headers.keys()]) {
            if (key.startsWith('x-stainless')) {
              headers.delete(key);
            }
          }
          return globalThis.fetch(url, { ...init, headers });
        }
        return globalThis.fetch(url, init);
      },
    });
  }

  async streamChat(
    messages: ChatMessage[],
    onDelta: (delta: string) => void,
    onDone: () => void,
    onError: (error: string) => void,
    options?: StreamOptions,
  ): Promise<void> {
    try {
      if (this.settings.provider === 'anthropic') {
        await this.streamAnthropic(messages, onDelta, onDone, onError, options);
        return;
      }

      // OpenAI-compatible path with tool calling support
      await this.streamWithTools(
        messages.map((m) => ({ role: m.role, content: m.content })),
        onDelta,
        onDone,
        options,
        0,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('PDF Canvas AI — streamChat error:', err);
      onError(`API error: ${msg}`);
    }
  }

  /**
   * Streaming with tool call loop for OpenAI-compatible APIs.
   * Each round streams the response. If the model requests tool calls,
   * we execute them and recurse. Text deltas are forwarded immediately.
   */
  private async streamWithTools(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: any[],
    onDelta: (delta: string) => void,
    onDone: () => void,
    options: StreamOptions | undefined,
    depth: number,
  ): Promise<void> {
    if (depth >= MAX_TOOL_ROUNDS) {
      onDone();
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any = {
      model: this.settings.model,
      messages,
      stream: true,
      max_tokens: 4096,
    };

    if (options?.tools?.length && options.executeToolCall) {
      params.tools = options.tools;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = await this.client.chat.completions.create(params) as any;

    const toolCalls: ToolCallAccumulator[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // Forward text content immediately
      if (delta.content) {
        onDelta(delta.content);
      }

      // Accumulate tool calls from stream
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dtc = (delta as any).tool_calls;
      if (dtc && Array.isArray(dtc)) {
        for (const tc of dtc) {
          const idx = tc.index ?? 0;
          while (toolCalls.length <= idx) {
            toolCalls.push({ id: '', name: '', arguments: '' });
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
        }
      }
    }

    // If there were tool calls, execute and loop
    if (toolCalls.length > 0 && options?.executeToolCall) {
      // Build assistant message with tool calls
      const assistantMsg = {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };

      const newMessages = [...messages, assistantMsg];

      for (const tc of toolCalls) {
        options.onToolCall?.({ name: tc.name, args: tc.arguments });

        let result: string;
        try {
          const args = JSON.parse(tc.arguments);
          result = await options.executeToolCall(tc.name, args);
        } catch (err) {
          result = `Error executing ${tc.name}: ${err instanceof Error ? err.message : String(err)}`;
        }

        newMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        });
      }

      // Recurse for the next round
      await this.streamWithTools(newMessages, onDelta, onDone, options, depth + 1);
      return;
    }

    onDone();
  }

  /**
   * Stream using Anthropic's native Messages API with tool use support.
   */
  private async streamAnthropic(
    messages: ChatMessage[],
    onDelta: (delta: string) => void,
    onDone: () => void,
    onError: (error: string) => void,
    options?: StreamOptions,
  ): Promise<void> {
    const systemMsg = messages.find((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');

    await this.streamAnthropicLoop(
      systemMsg?.content,
      nonSystem.map((m) => ({ role: m.role, content: m.content })),
      onDelta,
      onDone,
      onError,
      options,
      0,
    );
  }

  private async streamAnthropicLoop(
    systemPrompt: string | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: any[],
    onDelta: (delta: string) => void,
    onDone: () => void,
    onError: (error: string) => void,
    options: StreamOptions | undefined,
    depth: number,
  ): Promise<void> {
    if (depth >= MAX_TOOL_ROUNDS) {
      onDone();
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = {
      model: this.settings.model,
      max_tokens: 4096,
      stream: true,
      messages,
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }
    if (options?.tools?.length && options.executeToolCall) {
      body.tools = options.tools.map((t: ToolDefinition) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    try {
      const baseUrl = this.settings.baseUrl.replace(/\/v1\/?$/, '');
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.settings.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        onError(`Anthropic API error (${res.status}): ${text}`);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        onError('No response body from Anthropic API');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      // Track tool use blocks
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolUseBlocks: { id: string; name: string; input: any }[] = [];
      let currentToolId = '';
      let currentToolName = '';
      let currentToolInput = '';
      let stopReason = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);

            if (event.type === 'content_block_start') {
              if (event.content_block?.type === 'tool_use') {
                currentToolId = event.content_block.id;
                currentToolName = event.content_block.name;
                currentToolInput = '';
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'text_delta' && event.delta.text) {
                onDelta(event.delta.text);
              } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                currentToolInput += event.delta.partial_json;
              }
            } else if (event.type === 'content_block_stop') {
              if (currentToolName) {
                let parsedInput = {};
                try {
                  parsedInput = JSON.parse(currentToolInput);
                } catch {
                  // Malformed input
                }
                toolUseBlocks.push({
                  id: currentToolId,
                  name: currentToolName,
                  input: parsedInput,
                });
                currentToolName = '';
                currentToolInput = '';
              }
            } else if (event.type === 'message_delta') {
              if (event.delta?.stop_reason) {
                stopReason = event.delta.stop_reason;
              }
            }
          } catch {
            // Ignore malformed SSE lines
          }
        }
      }

      // If tool use, execute and loop
      if (stopReason === 'tool_use' && toolUseBlocks.length > 0 && options?.executeToolCall) {
        // Build assistant message with tool use content
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const assistantContent: any[] = [];
        for (const block of toolUseBlocks) {
          options.onToolCall?.({ name: block.name, args: JSON.stringify(block.input) });
          assistantContent.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }

        const newMessages = [
          ...messages,
          { role: 'assistant', content: assistantContent },
        ];

        // Execute tools and add results
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolResults: any[] = [];
        for (const block of toolUseBlocks) {
          let result: string;
          try {
            result = await options.executeToolCall(block.name, block.input);
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }

        newMessages.push({ role: 'user', content: toolResults });

        await this.streamAnthropicLoop(
          systemPrompt,
          newMessages,
          onDelta,
          onDone,
          onError,
          options,
          depth + 1,
        );
        return;
      }

      onDone();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('PDF Canvas AI — streamAnthropic error:', err);
      onError(`Anthropic API error: ${msg}`);
    }
  }
}
