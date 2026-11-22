import { join } from "node:path";
import { home, lockFile, readJSON, writeJSON } from "./home.ts";

/** config.json. It holds no secrets: the private key stays in the key store and the enrollment credential is never saved. */
export interface Config {
  server: string;
  workspace_id: string;
  device_id: string;
  address: string;
  device_name: string;
  key_name: string;
  key_provider: string;
  enrolled_at: string;
}

export const NOT_ENROLLED = "this computer is not enrolled; run: torbit-bridge setup";

export function readConfig(): Config | undefined {
  return readJSON<Config>(join(home(), "config.json"));
}
export function writeConfig(c: Config): void {
  writeJSON(join(home(), "config.json"), c);
}

/** The dedupe record for one Outlook entry id. Only ids, outcomes and times are stored; never subjects, addresses or bodies. */
export interface ItemRecord {
  outcome: "delivered" | "skipped";
  status: number;
  at: string;
  received?: string;
}

/** state.json. The layout is the same as the PowerShell and Go bridges, so an existing enrollment keeps its delivered ids. */
export interface State {
  version: number;
  cursor?: string;
  last_run?: string;
  last_sweep?: string;
  items: Record<string, ItemRecord>;
  pending: string[];
}

const statePath = () => join(home(), "state.json");

function normalize(raw: Partial<State> & { pending?: unknown }): State {
  // PowerShell's ConvertTo-Json wrote null or a bare string where an array of one was meant.
  let pending: string[] = [];
  if (Array.isArray(raw.pending)) pending = raw.pending.filter((x): x is string => typeof x === "string");
  else if (typeof raw.pending === "string" && raw.pending) pending = [raw.pending];
  return { ...raw, version: raw.version || 1, items: raw.items ?? {}, pending };
}

export function readState(): State {
  const raw = readJSON<Partial<State>>(statePath());
  return normalize(raw ?? {});
}

/** Read-modify-write under a lock file, so a running worker and a manual backfill do not overwrite each other. */
export async function updateState(mutate: (s: State) => void): Promise<void> {
  const unlock = await lockFile(statePath() + ".lock");
  try {
    const s = readState();
    mutate(s);
    writeJSON(statePath(), s);
  } finally {
    unlock();
  }
}
