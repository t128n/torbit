import { logf } from "./home.ts";
import { type Http, sendItem } from "./http.ts";
import { type Config, type ItemRecord, readConfig, readState, updateState } from "./state.ts";
import type { Adapter, ItemRef, KeyStore, Signer } from "./types.ts";
import { fmtTime, parseTime } from "./util.ts";

export const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
export const CURSOR_OVERLAP_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 4;

/** Sleeps, returning early when the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface SweepResult { seen: number; delivered: number; skipped: number; pending: number }

/** Delivers Outlook items to Orbit. */
export class Engine {
  /** a test seam */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep;

  constructor(
    readonly http: Http,
    readonly config: Config,
    readonly signer: Signer,
    readonly adapter: Adapter,
  ) {}

  /**
   * Delivers every Inbox item received at or after `since` that is not yet in the state.
   * 5xx and network errors are retried with backoff; when attempts run out the rest of the sweep
   * waits for the next one. 401/404/413 and other 4xx are recorded as skipped and never sent again.
   */
  async sweep(since: Date, trackPending: boolean, signal?: AbortSignal): Promise<SweepResult> {
    const known = readState().items;
    const items = (await this.adapter.list(since)).filter((it) => it.receivedTime >= since);
    const res: SweepResult = { seen: items.length, delivered: 0, skipped: 0, pending: 0 };
    const unresolved: ItemRef[] = [];
    let halted = false;

    for (const it of items) {
      if (known[it.entryId]) continue;
      if (halted || signal?.aborted) {
        unresolved.push(it);
        continue;
      }
      let r;
      for (let attempt = 1; ; attempt++) {
        r = await sendItem(this.http, this.config, this.signer, it, (id) => this.adapter.read(id));
        if (r.outcome !== "Retry" || attempt >= MAX_ATTEMPTS) break;
        await this.sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!, signal);
        if (signal?.aborted) break;
      }
      if (r.outcome === "Retry") {
        halted = true;
        unresolved.push(it);
        continue;
      }
      const rec: ItemRecord = { outcome: "delivered", status: r.status, at: fmtTime(new Date()) };
      if (r.outcome === "Delivered") {
        res.delivered++;
      } else {
        rec.outcome = "skipped";
        rec.received = fmtTime(it.receivedTime); // lets setup --force resend after an auth failure
        res.skipped++;
      }
      await updateState((s) => { s.items[it.entryId] = rec; });
      known[it.entryId] = rec;
    }

    res.pending = unresolved.length;
    if (trackPending) {
      const times = (xs: ItemRef[]) => xs.map((x) => x.receivedTime.getTime()).sort((a, b) => a - b);
      let cursor: number | undefined;
      if (unresolved.length > 0) cursor = times(unresolved)[0];
      else if (items.length > 0) cursor = times(items).at(-1);
      const now = fmtTime(new Date());
      await updateState((s) => {
        s.pending = unresolved.map((u) => u.entryId);
        s.last_run = s.last_sweep = now;
        if (cursor !== undefined) s.cursor = fmtTime(new Date(cursor));
      });
    }
    logf(`sweep: seen ${res.seen}, delivered ${res.delivered}, skipped ${res.skipped}, pending ${res.pending}`);
    return res;
  }

  /**
   * Sweeps from the stored cursor (minus an overlap for clock skew; dedupe makes the overlap harmless).
   * The first sweep starts at the enrollment time: older mail is the job of backfill.
   */
  runOnce(signal?: AbortSignal): Promise<SweepResult> {
    const st = readState();
    const cursor = parseTime(st.cursor);
    const enrolled = parseTime(this.config.enrolled_at);
    const since = cursor ? new Date(cursor.getTime() - CURSOR_OVERLAP_MS) : (enrolled ?? new Date(Date.now() - 3600_000));
    return this.sweep(since, true, signal);
  }

  /** Sweeps now and then every interval until the signal aborts. A failing sweep (Outlook closed, Orbit down) is logged and tried at the next wake-up. */
  async run(intervalMs: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce(signal);
      } catch (e) {
        logf(`sweep failed: ${e instanceof Error ? e.message : e}`);
      }
      await this.sleep(intervalMs, signal);
    }
  }

  /** Delivers inbox items received since a date, once. It shares the dedupe record with `run` and does not move the run cursor. */
  backfill(since: Date, signal?: AbortSignal): Promise<SweepResult> {
    return this.sweep(since, false, signal);
  }
}

export interface Status {
  enrolled: boolean;
  deviceId: string;
  server: string;
  address: string;
  keyProvider: string;
  keyPresent: boolean;
  lastRun: string;
  delivered: number;
  skipped: number;
  pending: number;
}

export async function getStatus(keys: KeyStore): Promise<Status> {
  const cfg = readConfig();
  const s: Status = {
    enrolled: !!cfg, deviceId: "", server: "", address: "", keyProvider: "", keyPresent: false,
    lastRun: "", delivered: 0, skipped: 0, pending: 0,
  };
  if (!cfg) return s;
  const st = readState();
  Object.assign(s, { deviceId: cfg.device_id, server: cfg.server, address: cfg.address, keyProvider: cfg.key_provider, lastRun: st.last_run ?? "", pending: st.pending.length });
  s.keyPresent = await keys.publicKey(cfg.key_name, cfg.key_provider).then(() => true, () => false);
  for (const r of Object.values(st.items)) {
    if (r.outcome === "delivered") s.delivered++;
    else if (r.outcome === "skipped") s.skipped++;
  }
  return s;
}
