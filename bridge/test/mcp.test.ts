import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Http } from "../src/core/http.ts";
import { MAX_BODY_BYTES } from "../src/core/sign.ts";
import { type Config, readState } from "../src/core/state.ts";
import { Engine, MAX_ATTEMPTS } from "../src/core/sweep.ts";
import { fmtTime } from "../src/core/util.ts";
import { checkMsoutlookMcp } from "../src/commands/checks.ts";
import { McpOutlookAdapter } from "../src/platform/mcp/outlook.ts";
import { readHealth, readMcpSettings } from "../src/platform/mcp/dependency.ts";
import { FakeServer, isolate, MemKeys } from "./helpers.ts";

interface Reply {
  data: unknown;
  isError?: boolean;
}

type Tool = (args: Record<string, unknown>) => Reply;

/** A tiny stand-in for msoutlook-mcp: /health plus /mcp JSON-RPC with tools/call. */
class FakeMcp {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  health: Record<string, unknown> = { status: "connected", version: "0.2.0" };
  list: Tool = () => ({ data: { items: [], truncated: false } });
  read: Tool = () => ({ data: {} });
  private server?: ReturnType<typeof Bun.serve>;

  constructor(private readonly token = "mcp-token") {}

  start(): number {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/health") return Response.json(this.health);
        if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
        if (req.headers.get("authorization") !== `Bearer ${this.token}`) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const msg = (await req.json()) as {
          id?: number;
          method?: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        if (msg.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "msoutlook-mcp", version: "0.2.0" },
            },
          });
        }
        if (msg.id === undefined) return new Response(null, { status: 202 });
        if (msg.method !== "tools/call") {
          return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no method" } });
        }
        const name = msg.params?.name ?? "";
        const args = msg.params?.arguments ?? {};
        this.calls.push({ name, args });
        const reply = name === "list_mail" ? this.list(args) : name === "read_mail" ? this.read(args) : { data: {} };
        return Response.json({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            resultType: "complete",
            content: [{ type: "text", text: JSON.stringify(reply.data) }],
            structuredContent: reply.data,
            ...(reply.isError ? { isError: true } : {}),
          },
        });
      },
    });
    return this.server.port!;
  }

  stop(): void {
    this.server?.stop(true);
  }

  get serverPort(): number {
    return this.server?.port ?? 0;
  }
}

const homes: string[] = [];
const servers: FakeMcp[] = [];

beforeEach(() => {
  isolate();
  delete process.env.MSOUTLOOK_MCP_HOME;
});

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  delete process.env.MSOUTLOOK_MCP_HOME;
});

function useMcp(port: number, token = "mcp-token"): void {
  const dir = mkdtempSync(join(tmpdir(), "torbit-mcp-"));
  homes.push(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, port }));
  writeFileSync(join(dir, "token"), token + "\n");
  process.env.MSOUTLOOK_MCP_HOME = dir;
}

function startMcp(token = "mcp-token"): FakeMcp {
  const fake = new FakeMcp(token);
  servers.push(fake);
  useMcp(fake.start(), token);
  return fake;
}

const adapter = (): McpOutlookAdapter => new McpOutlookAdapter(readMcpSettings());

async function engineFor(a: McpOutlookAdapter) {
  const keys = new MemKeys();
  await keys.create("k");
  const cfg: Config = {
    server: "https://orbit.test", workspace_id: "w", device_id: "7c1d2e3a-4b5f-4a6b-8c7d-9e0f1a2b3c4d", address: "", device_name: "",
    key_name: "k", key_provider: "mem", enrolled_at: fmtTime(new Date(Date.now() - 3600_000)),
  };
  const orbit = new FakeServer();
  const e = new Engine(new Http({ fetch: orbit.fetch }), cfg, await keys.open("k"), a);
  e.sleep = async () => {};
  return { e, orbit };
}

test("list follows next_cursor, filters the exact boundary and drains a shared-timestamp block", async () => {
  const fake = startMcp();
  const since = new Date("2026-01-01T10:00:00.000Z");
  fake.list = (args) =>
    args.cursor === "page-2"
      ? {
          data: {
            items: [
              // the real cursor skips these, but a replaying daemon must not duplicate them either
              { entry_id: "b", received_at: "2026-01-01T10:00:01.000Z", size_bytes: 3 },
              { entry_id: "c", received_at: "2026-01-01T10:00:01.000Z", size_bytes: 4 },
            ],
            truncated: false,
          },
        }
      : {
          data: {
            items: [
              { entry_id: "old", received_at: "2026-01-01T09:59:59.000Z", size_bytes: 1 },
              { entry_id: "a", received_at: "2026-01-01T10:00:00.000Z", size_bytes: 2 },
              { entry_id: "b", received_at: "2026-01-01T10:00:01.000Z", size_bytes: 3 },
            ],
            truncated: true,
            next_cursor: "page-2",
          },
        };

  const items = await adapter().list(since);

  expect(items.map((i) => i.entryId)).toEqual(["a", "b", "c"]);
  expect(items.map((i) => i.size)).toEqual([2, 3, 4]);
  expect(fake.calls.map((c) => c.name)).toEqual(["list_mail", "list_mail"]);
  expect(fake.calls[0]!.args).toMatchObject({
    folder: "inbox", sort: "oldest", since_iso: since.toISOString(), limit: 1000,
  });
  expect(fake.calls[0]!.args.cursor).toBeUndefined();
  expect(fake.calls[1]!.args).toMatchObject({ cursor: "page-2", since_iso: since.toISOString() });
});

test("read makes one read_mail call and maps every field toMIME needs", async () => {
  const fake = startMcp();
  const bytes = Buffer.from("hello attachment");
  fake.read = () => ({
    data: {
      entry_id: "entry-1",
      received_at: "2026-01-01T10:00:00.000Z",
      size_bytes: 42,
      subject: "Subject",
      sender: "Zoë",
      sender_smtp: "zoe@example.com",
      sender_address: "/O=EXCHANGE/CN=Zoë",
      to: "me@example.com",
      body: "plain",
      html: "<p>html</p>",
      transport_headers: "Message-ID: <m@example.com>\r\nReferences: <r@example.com>\r\n",
      attachments: [
        {
          filename: "logo.png", mime_type: "image/png", content_id: "logo@example.com",
          is_inline: true, data_base64: bytes.toString("base64"),
        },
      ],
    },
  });

  const item = await adapter().read("entry-1");

  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]!.name).toBe("read_mail");
  expect(fake.calls[0]!.args).toEqual({
    entry_id: "entry-1",
    max_body_bytes: 0,
    include_html: true,
    include_transport_headers: true,
    attachments: "base64",
    max_attachment_bytes: MAX_BODY_BYTES,
    max_attachment_total_bytes: MAX_BODY_BYTES,
  });
  expect(item).toMatchObject({
    entryId: "entry-1", size: 42, subject: "Subject", senderName: "Zoë",
    senderEmail: "zoe@example.com", to: "me@example.com", body: "plain", htmlBody: "<p>html</p>",
  });
  expect(item.receivedTime.toISOString()).toBe("2026-01-01T10:00:00.000Z");
  expect(item.transportHeaders).toContain("References:");
  expect(item.attachments).toHaveLength(1);
  expect(item.attachments[0]!.fileName).toBe("logo.png");
  expect(item.attachments[0]!.contentId).toBe("logo@example.com");
  expect(item.attachments[0]!.isInline).toBe(true);
  expect(Buffer.from(item.attachments[0]!.bytes).toString()).toBe("hello attachment");
});

test("a skipped attachment skips the whole item with 413 and sends nothing", async () => {
  const fake = startMcp();
  fake.list = () => ({
    data: { items: [{ entry_id: "a", received_at: new Date().toISOString(), size_bytes: 10 }], truncated: false },
  });
  fake.read = () => ({
    data: {
      entry_id: "a", received_at: new Date().toISOString(), size_bytes: 10, subject: "big",
      body: "b", attachments: [{ filename: "big.bin", skipped_reason: "total_cap" }],
    },
  });
  const { e, orbit } = await engineFor(adapter());

  const r = await e.runOnce();

  expect(r).toMatchObject({ delivered: 0, skipped: 1, pending: 0 });
  expect(orbit.bodies).toHaveLength(0);
  expect(readState().items["a"]).toMatchObject({ outcome: "skipped", status: 413 });
});

test("a retryable OUTLOOK_UNAVAILABLE read becomes Retry and leaves the item pending", async () => {
  const fake = startMcp();
  fake.list = () => ({
    data: { items: [{ entry_id: "a", received_at: new Date().toISOString(), size_bytes: 10 }], truncated: false },
  });
  fake.read = () => ({
    isError: true,
    data: {
      error: "OUTLOOK_UNAVAILABLE", retryable: true,
      message: "Outlook isn't running. Minimize Outlook instead of closing it, then retry.",
    },
  });
  const { e, orbit } = await engineFor(adapter());

  const r = await e.runOnce();

  expect(r).toMatchObject({ delivered: 0, skipped: 0, pending: 1 });
  expect(orbit.bodies).toHaveLength(0);
  expect(readState().items).toEqual({});
  expect(fake.calls.filter((c) => c.name === "read_mail")).toHaveLength(MAX_ATTEMPTS);
});

test("a 401 from the daemon fails the sweep with a hint and marks nothing skipped", async () => {
  const fake = new FakeMcp("the-current-token");
  servers.push(fake);
  useMcp(fake.start(), "a-stale-token");
  const { e, orbit } = await engineFor(adapter());

  await expect(e.runOnce()).rejects.toThrow(/401/);
  expect(orbit.bodies).toHaveLength(0);
  expect(readState().items).toEqual({});
});

test("a non-retryable daemon error while reading fails the sweep and marks nothing skipped", async () => {
  const fake = startMcp();
  fake.list = () => ({
    data: { items: [{ entry_id: "a", received_at: new Date().toISOString(), size_bytes: 10 }], truncated: false },
  });
  fake.read = () => ({
    isError: true,
    data: { error: "OUTLOOK_ERROR", retryable: false, message: "Windows blocked COM automation of Outlook." },
  });
  const { e, orbit } = await engineFor(adapter());

  await expect(e.runOnce()).rejects.toThrow(/blocked COM automation/);
  expect(orbit.bodies).toHaveLength(0);
  expect(readState().items).toEqual({});
  expect(fake.calls.filter((c) => c.name === "read_mail")).toHaveLength(1);
});

test("health and the daemon settings are read from the daemon's own files", async () => {
  const fake = startMcp();
  const settings = readMcpSettings();
  expect(settings.port).toBe(fake.serverPort);
  expect(settings.token).toBe("mcp-token");
  expect(settings.mcpURL).toBe(`http://127.0.0.1:${fake.serverPort}/mcp`);

  const health = await readHealth(settings);
  expect(health).toMatchObject({ reachable: true, status: "connected", version: "0.2.0" });
});

test("doctor fails clearly when msoutlook-mcp is absent, stopped or too old", async () => {
  const empty = mkdtempSync(join(tmpdir(), "torbit-mcp-empty-"));
  homes.push(empty);
  process.env.MSOUTLOOK_MCP_HOME = empty;
  const absent = await checkMsoutlookMcp();
  expect(absent[0]).toMatchObject({ name: "msoutlook-mcp", level: "fail" });
  expect(absent[0]!.hint).toContain("msoutlook-mcp setup");

  const fake = startMcp();
  fake.health = { status: "connected", version: "0.1.1" };
  const old = await checkMsoutlookMcp();
  expect(old.find((c) => c.name === "mcp version")).toMatchObject({ level: "fail" });
  expect(old.find((c) => c.name === "mcp version")!.hint).toContain("0.2.0");

  fake.stop();
  servers.splice(servers.indexOf(fake), 1);
  const stopped = await checkMsoutlookMcp();
  expect(stopped.find((c) => c.name === "mcp daemon")).toMatchObject({ level: "fail" });
  expect(stopped.find((c) => c.name === "mcp daemon")!.hint).toContain("msoutlook-mcp install");
});
