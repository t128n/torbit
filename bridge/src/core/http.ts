import { isIP } from "node:net";
import { logf } from "./home.ts";
import { MAX_BODY_BYTES, requestHeaders } from "./sign.ts";
import type { Config } from "./state.ts";
import { toMIME } from "./mime.ts";
import type { Item, ItemRef, Platform, Signer } from "./types.ts";
import { errText } from "./util.ts";

export type FetchFn = (url: string, init: RequestInit & { proxy?: string }) => Promise<Response>;

/** A status (0 = network error) and the body text. */
export interface Reply {
  status: number;
  body: string;
  /** the server's Date header, when present */
  date?: Date;
  err?: unknown;
}

export interface Request {
  headers?: Record<string, string>;
  contentType?: string;
  body?: Uint8Array | string;
}

/** The client every request goes through. Tests pass their own `fetch`. */
export class Http {
  constructor(private readonly opts: { platform?: Platform; fetch?: FetchFn } = {}) {}

  private fetchFn(): FetchFn {
    return this.opts.fetch ?? ((url, init) => fetch(url, init));
  }

  async do(method: string, url: string, r: Request = {}): Promise<Reply> {
    const headers: Record<string, string> = { "User-Agent": "torbit-bridge", ...r.headers };
    if (r.contentType) headers["Content-Type"] = r.contentType;
    try {
      const res = await this.fetchFn()(url, {
        method,
        headers,
        body: r.body as BodyInit | undefined,
        redirect: "manual", // an API answer that redirects is not followed
        signal: AbortSignal.timeout(60_000),
        proxy: this.opts.platform?.proxyFor(new URL(url)),
      });
      const text = (await res.text()).slice(0, 1 << 20);
      const d = res.headers.get("date");
      const date = d ? new Date(d) : undefined;
      return { status: res.status, body: text, date: date && !Number.isNaN(date.getTime()) ? date : undefined };
    } catch (err) {
      return { status: 0, body: "", err };
    }
  }

  /** GET with redirects followed, a 256 MiB limit and a long timeout, for release downloads. */
  async download(url: string): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await this.fetchFn()(url, {
        headers: { "User-Agent": "torbit-bridge" },
        signal: AbortSignal.timeout(10 * 60_000),
        proxy: this.opts.platform?.proxyFor(new URL(url)),
      });
    } catch (e) {
      throw new Error(errText(e));
    }
    if (res.status !== 200) throw new Error(`download answered ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 256 << 20) throw new Error("download is larger than 256 MiB");
    return buf;
  }
}

/** Requires https (http only for loopback). */
export function assertServerURL(server: string): void {
  let u: URL;
  try {
    u = new URL(server);
  } catch {
    throw new Error("server must be a full URL such as https://torbit.example.com");
  }
  if (!u.host) throw new Error("server must be a full URL such as https://torbit.example.com");
  if (u.protocol === "https:") return;
  if (u.protocol === "http:") {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || (isIP(host) && (host === "::1" || host.startsWith("127.")))) return;
  }
  throw new Error("server must use https (http only for localhost)");
}

export type Outcome = "Delivered" | "Retry" | "Permanent";
export interface SendResult { outcome: Outcome; status: number; reason: string }

const r = (outcome: Outcome, status: number, reason = ""): SendResult => ({ outcome, status, reason });

export async function sendMessage(http: Http, cfg: Config, signer: Signer, mime: Uint8Array): Promise<SendResult> {
  if (mime.length > MAX_BODY_BYTES) return r("Permanent", 413, "Message is larger than 2 MiB.");
  let headers: Record<string, string>;
  try {
    headers = await requestHeaders(cfg.device_id, mime, signer);
  } catch (e) {
    return r("Permanent", 0, "Could not sign the message: " + errText(e));
  }
  const url = cfg.server.replace(/\/+$/, "") + "/api/v1/mail/inbound/bridge/" + cfg.device_id;
  const res = await http.do("POST", url, { headers, contentType: "message/rfc822", body: mime });
  const s = res.status;
  if (s === 200) return r("Delivered", s);
  if (s === 0 || s >= 500 || s === 429 || s === 408) return r("Retry", s, "Orbit or the network is not available; try again later.");
  if (s === 401 && res.body.includes("device_revoked")) return r("Permanent", s, "This device was revoked in Orbit. Run: torbit-bridge setup --force");
  if (s === 401 || s === 404) return r("Permanent", s, "Orbit rejected this device. It may be revoked; enroll again.");
  if (s === 413) return r("Permanent", s, "Message is too large for Orbit.");
  return r("Permanent", s, `Orbit answered ${s}.`);
}

/** Reads one inbox item from Outlook (attachments included) and delivers it. */
export async function sendItem(
  http: Http,
  cfg: Config,
  signer: Signer,
  ref: ItemRef,
  read: (entryId: string) => Promise<Item>,
): Promise<SendResult> {
  if (ref.size > MAX_BODY_BYTES) {
    // clearly over the limit: do not read the item or build the message
    logf(`item ${ref.entryId} -> Permanent (413, too large)`);
    return r("Permanent", 413, "Message is larger than 2 MiB.");
  }
  let mime: Uint8Array;
  try {
    mime = toMIME(await read(ref.entryId));
  } catch (e) {
    logf(`item ${ref.entryId} -> Retry (could not read the item: ${errText(e)})`);
    return r("Retry", 0, "Could not read the item from Outlook: " + errText(e));
  }
  const res = await sendMessage(http, cfg, signer, mime);
  logf(`item ${ref.entryId} -> ${res.outcome} (${res.status})`);
  return res;
}
