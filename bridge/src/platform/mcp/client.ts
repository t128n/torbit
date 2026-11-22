/**
 * A minimal Streamable-HTTP MCP client for msoutlook-mcp.
 *
 * The daemon is stateless: every call is a JSON-RPC POST to /mcp with a bearer
 * token. initialize is sent once per adapter; there is no session header to keep.
 */

export type McpFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** An error from the daemon. `retryable` means Outlook is away, not that the request was wrong. */
export class McpError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpClientOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  fetch?: McpFetch;
}

type JsonRpcId = number;

interface JsonRpcError {
  code?: number;
  message?: string;
}

interface ToolResult {
  content?: { type?: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class McpClient {
  private nextId = 1;
  private initialized?: Promise<void>;
  private sessionId?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: McpFetch;

  constructor(private readonly opts: McpClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 120_000; // a base64 read_mail is allowed to take a while
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.initialize();
    const result = (await this.rpc("tools/call", { name, arguments: args })) as ToolResult;
    if (result.isError === true) throw this.toolError(result);
    const data = this.payload(result);
    if (data === undefined) throw new McpError(`msoutlook-mcp returned no data for ${name}`, false);
    return data as T;
  }

  close(): void {
    this.initialized = undefined;
  }

  private initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.doInitialize().catch((e) => {
        this.initialized = undefined; // the next call may find a reachable daemon
        throw e;
      });
    }
    return this.initialized;
  }

  private async doInitialize(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "torbit-bridge", version: "1" },
    });
    // Notifications have no id and need no answer; the daemon returns 202.
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id: JsonRpcId = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (res.status === 401) {
      throw new McpError(
        "msoutlook-mcp denied the bridge's token (HTTP 401). Restart the daemon so it reads the current token " +
          "(msoutlook-mcp install); if it still fails, rotate the token with msoutlook-mcp setup --rotate-token " +
          "and start it again.",
        false,
      );
    }
    if (!res.ok) {
      const retryable = res.status >= 500;
      throw new McpError(`msoutlook-mcp answered HTTP ${res.status} on ${method}. Run: msoutlook-mcp doctor`, retryable);
    }
    let body: unknown;
    try {
      body = await readRpcBody(res, id);
    } catch (e) {
      throw new McpError(`msoutlook-mcp answered ${method} with something that is not JSON: ${errText(e)}`, false);
    }
    const msg = asRecord(body);
    if (!msg) throw new McpError(`msoutlook-mcp answered ${method} with an invalid JSON-RPC message`, false);
    const error = asRecord(msg.error) as JsonRpcError | undefined;
    if (error) {
      throw new McpError(`msoutlook-mcp error on ${method}: ${error.message ?? `code ${error.code ?? "unknown"}`}`, false);
    }
    return msg.result;
  }

  private async post(payload: unknown, expectAnswer = true): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(this.opts.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new McpError(
        `msoutlook-mcp is not running at ${loopbackLabel(this.opts.url)} (${errText(e)}). ` +
          "Start it: msoutlook-mcp install (or msoutlook-mcp serve in a terminal).",
        true,
      );
    }
    if (expectAnswer && res.status === 202) {
      throw new McpError("msoutlook-mcp accepted the request but sent no answer", true);
    }
    return res;
  }

  private toolError(result: ToolResult): McpError {
    const data = asRecord(this.payload(result)) ?? {};
    const message = typeof data.message === "string" && data.message ? data.message : "msoutlook-mcp returned an error.";
    if (data.retryable === true) return new McpError(message, true);
    return new McpError(`${message} Run "msoutlook-mcp doctor" for details.`, false);
  }

  private payload(result: ToolResult): unknown {
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = result.content?.find((c) => typeof c.text === "string")?.text;
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
}

/** A JSON answer, or the matching JSON-RPC frame from an SSE answer (Streamable HTTP may use either). */
async function readRpcBody(res: Response, id: JsonRpcId): Promise<unknown> {
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return res.json();
  const text = await res.text();
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      continue;
    }
    const msg = asRecord(frame);
    if (msg && (msg.id === id || msg.error)) return frame;
  }
  throw new Error("the event stream carried no JSON-RPC answer");
}

function loopbackLabel(url: string): string {
  try {
    const u = new URL(url);
    return `http://${u.host}/mcp`;
  } catch {
    return url;
  }
}
