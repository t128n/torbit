import { rmSync } from "node:fs";
import { join } from "node:path";
import { assertServerURL, type Http } from "./http.ts";
import { home, logf } from "./home.ts";
import { type Config, readConfig, updateState, writeConfig } from "./state.ts";
import type { KeyStore } from "./types.ts";
import { computerName, errText, fmtTime, newUUID, parseTime } from "./util.ts";

/** An Orbit session token (sent as the session cookie) or an API token (Bearer). Used for one call, never stored or logged. */
export interface Credential { kind: "session" | "api"; value: string }

function credentialHeaders(c: Credential, server: string): Record<string, string> {
  const u = new URL(server);
  const h: Record<string, string> = { Origin: `${u.protocol}//${u.host}`, Accept: "application/json" };
  if (c.kind === "api") h.Authorization = "Bearer " + c.value;
  else h.Cookie = "__Host-orbit_session=" + c.value;
  return h;
}

export interface EnrollOptions {
  server: string;
  workspaceId: string;
  name?: string;
  provider?: string;
  credential: Credential;
  force?: boolean;
}

export async function enroll(http: Http, keys: KeyStore, o: EnrollOptions): Promise<Config> {
  assertServerURL(o.server);
  let name = o.name || computerName() || "Outlook bridge";
  if ([...name].length > 80) name = [...name].slice(0, 80).join("");
  if (readConfig() && !o.force) throw new Error("this computer is already enrolled; use --force to enroll again");

  const keyName = "Torbit-Bridge-" + newUUID().replaceAll("-", "");
  let created: { provider: string; spkiBase64: string };
  try {
    created = await keys.create(keyName, o.provider);
  } catch (e) {
    throw new Error("could not create the signing key in the Windows key store: " + errText(e));
  }
  const fail = async (msg: string): Promise<never> => {
    await keys.delete(keyName, created.provider).catch(() => {});
    throw new Error(msg);
  };

  const server = o.server.replace(/\/+$/, "");
  const url = `${server}/api/v1/workspaces/${encodeURIComponent(o.workspaceId)}/mail/bridge/devices`;
  const res = await http.do("POST", url, {
    headers: credentialHeaders(o.credential, server),
    contentType: "application/json",
    body: JSON.stringify({ name, public_key: created.spkiBase64 }),
  });
  const s = res.status;
  if (s === 401 || s === 403) return fail("Orbit did not accept the credential. Sign in again and use a fresh session token");
  if (s === 404) return fail("Orbit answered 404. Check the workspace id and that the bridge is turned on for this server");
  if (s === 0) return fail(`could not reach Orbit. Check the server URL and your network or proxy (${errText(res.err)})`);
  if (s !== 201) return fail(`enrollment failed with status ${s}`);

  let dev: { id?: string; address?: string; name?: string };
  try {
    dev = JSON.parse(res.body);
  } catch {
    dev = {};
  }
  if (!dev.id) return fail("Orbit answered with an unexpected enrollment response");

  const cfg: Config = {
    server,
    workspace_id: o.workspaceId,
    device_id: dev.id,
    address: dev.address ?? "",
    device_name: dev.name ?? "",
    key_name: keyName,
    key_provider: created.provider,
    enrolled_at: fmtTime(new Date()),
  };
  try {
    writeConfig(cfg);
  } catch (e) {
    return fail(errText(e));
  }
  if (o.force) await resetAuthSkipped();
  logf(`enrolled device ${cfg.device_id} with ${created.provider}`);
  return cfg;
}

/** After a new enrollment the earlier 401/404 skips (the old device was rejected) are stale: forget them so the next sweep sends those items again. */
async function resetAuthSkipped(): Promise<void> {
  try {
    await updateState((s) => {
      let oldest: Date | undefined;
      for (const [id, rec] of Object.entries(s.items)) {
        if (rec.outcome !== "skipped" || (rec.status !== 401 && rec.status !== 404)) continue;
        const t = parseTime(rec.received);
        if (t && (!oldest || t < oldest)) oldest = t;
        delete s.items[id];
      }
      const c = parseTime(s.cursor);
      if (c && oldest && c > oldest) s.cursor = fmtTime(oldest);
    });
  } catch {
    /* best effort */
  }
}

/** Marks the device revoked in Orbit (unless localOnly), then deletes the local key, config and state. If the server call fails nothing is removed. */
export async function revoke(http: Http, keys: KeyStore, cred: Credential | undefined, localOnly: boolean): Promise<void> {
  const cfg = readConfig();
  if (!cfg) throw new Error("this computer is not enrolled");
  if (!localOnly) {
    if (!cred?.value) throw new Error("a credential is needed to revoke the device in Orbit; use --local-only to only remove the local data");
    assertServerURL(cfg.server);
    const url = `${cfg.server.replace(/\/+$/, "")}/api/v1/workspaces/${encodeURIComponent(cfg.workspace_id)}/mail/bridge/devices/${encodeURIComponent(cfg.device_id)}`;
    const res = await http.do("DELETE", url, { headers: credentialHeaders(cred, cfg.server) });
    const s = res.status;
    if (s === 401 || s === 403) throw new Error("Orbit did not accept the credential. Sign in again and use a fresh session token");
    if (s === 404) throw new Error("Orbit does not know this device. If it was already removed, run revoke with --local-only");
    if (s === 0) throw new Error(`could not reach Orbit. Check the server URL and your network or proxy (${errText(res.err)})`);
    if (s !== 204 && s !== 200) throw new Error(`revoke failed with status ${s}`);
  }
  await keys.delete(cfg.key_name, cfg.key_provider).catch(() => {});
  for (const f of ["config.json", "state.json"]) rmSync(join(home(), f), { force: true });
  logf(`revoked device ${cfg.device_id}; local key, config and state removed`);
}
