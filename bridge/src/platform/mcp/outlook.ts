import { MAX_BODY_BYTES } from "../../core/sign.ts";
import { FatalReadError, ItemUnusableError, type Adapter, type Attachment, type Item, type ItemRef } from "../../core/types.ts";
import { McpClient, McpError } from "./client.ts";
import { readMcpSettings, type McpSettings } from "./dependency.ts";

interface RawSummary {
  entry_id?: string;
  received_at?: string | null;
  size_bytes?: number | null;
}

interface RawListPage {
  items?: RawSummary[];
  truncated?: boolean;
  next_cursor?: string | null;
}

interface RawAttachment {
  filename?: string | null;
  mime_type?: string | null;
  content_id?: string | null;
  is_inline?: boolean | null;
  data_base64?: string | null;
  skipped_reason?: "too_large" | "total_cap" | "unavailable" | null;
}

interface RawDetail extends RawSummary {
  subject?: string | null;
  sender?: string | null;
  sender_address?: string | null;
  sender_smtp?: string | null;
  to?: string | null;
  body?: string | null;
  html?: string | null;
  transport_headers?: string | null;
  attachments?: RawAttachment[] | null;
}

const orEmpty = (v: string | null | undefined): string => v ?? "";

const dateOrEpoch = (v: string | null | undefined): Date => {
  const d = v ? new Date(v) : new Date(NaN);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
};

/** Classic Outlook through the local msoutlook-mcp daemon (MCP Streamable HTTP). */
export class McpOutlookAdapter implements Adapter {
  private readonly client: McpClient;

  constructor(private readonly settings: McpSettings, client?: McpClient) {
    this.client = client ?? new McpClient({ url: settings.mcpURL, token: settings.token, timeoutMs: 120_000 });
  }

  /** Inbox only, oldest first. Follow next_cursor until the daemon says the page is not truncated. */
  async list(since: Date): Promise<ItemRef[]> {
    const seen = new Map<string, ItemRef>();
    let cursor: string | undefined;

    for (;;) {
      const page = await this.client.call<RawListPage>("list_mail", {
        folder: "inbox",
        sort: "oldest",
        since_iso: since.toISOString(),
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });

      for (const raw of page.items ?? []) {
        if (!raw.entry_id || !raw.received_at) continue;
        const receivedTime = new Date(raw.received_at);
        if (Number.isNaN(receivedTime.getTime())) continue;
        // Outlook filters at second/minute precision; the bridge keeps its own exact boundary.
        if (receivedTime < since) continue;
        if (!seen.has(raw.entry_id)) {
          seen.set(raw.entry_id, { entryId: raw.entry_id, receivedTime, size: raw.size_bytes ?? 0 });
        }
      }

      if (page.truncated !== true || !page.next_cursor || page.next_cursor === cursor) break;
      cursor = page.next_cursor;
    }

    return [...seen.values()].sort((a, b) => a.receivedTime.getTime() - b.receivedTime.getTime());
  }

  /** One read_mail carries every field toMIME() consumes, attachment bytes included. */
  async read(entryId: string): Promise<Item> {
    let raw: RawDetail;
    try {
      raw = await this.client.call<RawDetail>("read_mail", {
        entry_id: entryId,
        max_body_bytes: 0, // the helper truncates at 50k characters by default; the bridge must not clip bodies
        include_html: true,
        include_transport_headers: true,
        attachments: "base64",
        max_attachment_bytes: MAX_BODY_BYTES,
        max_attachment_total_bytes: MAX_BODY_BYTES,
      });
    } catch (e) {
      // A daemon error or token mismatch is not this item's fault: stop the sweep instead of retrying forever.
      if (e instanceof McpError && !e.retryable) throw new FatalReadError(e.message);
      throw e;
    }

    const attachments = raw.attachments ?? [];
    const skipped = attachments.find((a) => a.skipped_reason);
    if (skipped) {
      throw new ItemUnusableError(
        `msoutlook-mcp could not return all attachment bytes (${skipped.skipped_reason}); ` +
          "the item would be incomplete and is recorded as too large.",
        413,
      );
    }

    return {
      entryId: raw.entry_id ?? entryId,
      receivedTime: dateOrEpoch(raw.received_at),
      size: raw.size_bytes ?? 0,
      subject: orEmpty(raw.subject),
      senderName: orEmpty(raw.sender),
      // sender_smtp resolves Exchange-internal X.500 senders to SMTP; sender_address is the fallback.
      senderEmail: orEmpty(raw.sender_smtp) || orEmpty(raw.sender_address),
      to: orEmpty(raw.to),
      transportHeaders: orEmpty(raw.transport_headers),
      body: orEmpty(raw.body),
      htmlBody: orEmpty(raw.html),
      attachments: attachments.map((a): Attachment => ({
        fileName: orEmpty(a.filename) || "attachment",
        mimeType: orEmpty(a.mime_type),
        contentId: orEmpty(a.content_id),
        isInline: a.is_inline === true,
        bytes: Buffer.from(orEmpty(a.data_base64), "base64"),
      })),
    };
  }

  close(): void {
    this.client.close();
  }
}

/** Opens the adapter from the daemon's own config and token files. */
export function newMcpOutlook(opts?: { timeoutMs?: number }): Adapter {
  const settings = readMcpSettings();
  return new McpOutlookAdapter(
    settings,
    new McpClient({ url: settings.mcpURL, token: settings.token, timeoutMs: opts?.timeoutMs }),
  );
}
