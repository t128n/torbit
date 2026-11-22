import { join } from "node:path";
import type { Adapter, Attachment, Item, ItemRef } from "../../core/types.ts";
import { OUTLOOK_SCRIPT } from "./outlook.ps1.ts";

/** Turns a COM failure into text that says what to do. */
export function explainOutlookError(code: number | undefined): string {
  switch (code === undefined ? 0 : code >>> 0) {
    case 0x80040154: // REGDB_E_CLASSNOTREG
      return "Outlook (classic desktop version) is not installed. The bridge needs classic Outlook; new Outlook is not supported.";
    case 0x80070005: // access denied
    case 0x80080005: // server execution failed
    case 0x80004005: // unspecified
      return "Windows or your administrator blocked the bridge from using Outlook. Ask your IT team to allow torbit-bridge to use Outlook automation, make sure Outlook and the bridge run as the same non-elevated user, then try again.";
  }
  return "The bridge could not talk to Outlook. Make sure classic Outlook is installed and signed in, then try again.";
}

class OutlookError extends Error {
  constructor(readonly code: number | undefined, detail: string) {
    super(explainOutlookError(code));
    this.detail = detail;
  }
  detail: string;
}

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

const powershell = (): string => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** Escapes non-ASCII as \uXXXX so the helper's console code page never matters. */
const asciiJSON = (v: unknown): string => JSON.stringify(v).replace(/[^\x00-\x7e]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/** Classic Outlook through a PowerShell helper process (COM automation). */
export class OutlookAdapter implements Adapter {
  private proc?: ReturnType<typeof Bun.spawn>;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderr = "";

  constructor(private readonly timeoutMs = 120_000) {}

  private start(): ReturnType<typeof Bun.spawn> {
    if (this.proc) return this.proc;
    const encoded = Buffer.from(OUTLOOK_SCRIPT, "utf16le").toString("base64");
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(
        [powershell(), "-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true },
      );
    } catch (e) {
      throw new Error("could not start Windows PowerShell, which the bridge uses to talk to Outlook: " + (e as Error).message);
    }
    this.proc = proc;
    this.stderr = "";
    void this.pump(proc);
    void this.collectStderr(proc);
    void proc.exited.then(() => {
      if (this.proc === proc) this.proc = undefined;
      this.failAll(new Error("the Outlook helper stopped" + (this.stderr ? ": " + this.stderr.trim().slice(0, 300) : "")));
    });
    return proc;
  }

  private async collectStderr(proc: ReturnType<typeof Bun.spawn>) {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) this.stderr = (this.stderr + dec.decode(chunk)).slice(-2000);
  }

  private async pump(proc: ReturnType<typeof Bun.spawn>) {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("{")) this.answer(line);
      }
    }
  }

  private answer(line: string) {
    let msg: { id: number; ok: boolean; result?: unknown; error?: { code?: number; message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new OutlookError(msg.error?.code, msg.error?.message ?? ""));
  }

  private failAll(err: Error) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private call<T>(req: Record<string, unknown>): Promise<T> {
    const proc = this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        proc.kill(); // a stuck helper (an Outlook dialog waiting for an answer) is replaced on the next call
        reject(new Error("Outlook did not answer in time. A dialog in Outlook may be waiting for an answer (profile, sign-in or a security prompt)."));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        (proc.stdin as import("bun").FileSink).write(asciiJSON({ id, ...req }) + "\n");
        void (proc.stdin as import("bun").FileSink).flush();
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  /** Connects to Outlook (starting it when needed). Used by doctor and setup. */
  async ping(): Promise<void> {
    await this.call({ op: "ping" });
  }

  async list(since: Date): Promise<ItemRef[]> {
    const r = await this.call<{ items: { id: string; receivedMs: number; size: number }[] }>({ op: "list", sinceMs: since.getTime() });
    return r.items.map((i) => ({ entryId: i.id, receivedTime: new Date(i.receivedMs), size: i.size }));
  }

  async read(entryId: string): Promise<Item> {
    const r = await this.call<{
      id: string; receivedMs: number; size: number; subject: string; senderName: string; senderEmail: string;
      to: string; body: string; html: string; headers: string;
      attachments: { name: string; mime: string; cid: string; data: string }[];
    }>({ op: "read", entryId });
    const attachments: Attachment[] = r.attachments.map((a) => ({
      fileName: a.name, mimeType: a.mime, contentId: a.cid, isInline: a.cid !== "", bytes: Buffer.from(a.data, "base64"),
    }));
    return {
      entryId: r.id, receivedTime: new Date(r.receivedMs), size: r.size, subject: r.subject, senderName: r.senderName,
      senderEmail: r.senderEmail, to: r.to, transportHeaders: r.headers, body: r.body, htmlBody: r.html, attachments,
    };
  }

  close(): void {
    const proc = this.proc;
    this.proc = undefined;
    this.failAll(new Error("closed"));
    try {
      proc?.kill();
    } catch {
      /* already gone */
    }
  }
}
