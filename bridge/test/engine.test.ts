import { beforeEach, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { diagnose, worst } from "../src/core/doctor.ts";
import { enroll, revoke } from "../src/core/enroll.ts";
import { assertServerURL, Http } from "../src/core/http.ts";
import { MAX_BODY_BYTES, HEADER_NONCE, HEADER_SIGNATURE } from "../src/core/sign.ts";
import { type Config, readConfig, readState } from "../src/core/state.ts";
import { Engine, MAX_ATTEMPTS } from "../src/core/sweep.ts";
import { compareVersions, assetName, verifySums } from "../src/core/update.ts";
import { fmtTime } from "../src/core/util.ts";
import { FakeAdapter, FakeServer, isolate, mail, MemKeys } from "./helpers.ts";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { home } from "../src/core/home.ts";
import { join } from "node:path";

beforeEach(() => { isolate(); });

async function newEngine(fs: FakeServer, ...items: ReturnType<typeof mail>[]) {
  const keys = new MemKeys();
  await keys.create("k");
  const cfg: Config = {
    server: "https://orbit.test", workspace_id: "w", device_id: "7c1d2e3a-4b5f-4a6b-8c7d-9e0f1a2b3c4d", address: "", device_name: "",
    key_name: "k", key_provider: "mem", enrolled_at: fmtTime(new Date(Date.now() - 3600_000)),
  };
  const adapter = new FakeAdapter(items);
  const e = new Engine(new Http({ fetch: fs.fetch }), cfg, await keys.open("k"), adapter);
  e.sleep = async () => {};
  return { e, adapter };
}

test("sweep delivers once and signs", async () => {
  const fs = new FakeServer();
  const { e } = await newEngine(fs, mail("a", 180_000), mail("b", 120_000));
  expect((await e.runOnce()).delivered).toBe(2);
  expect((await e.runOnce()).delivered).toBe(0);
  expect(fs.bodies).toHaveLength(2);
  const h = fs.headers[0]!;
  expect(h.get(HEADER_SIGNATURE)).toBeTruthy();
  expect(h.get(HEADER_NONCE)).toBeTruthy();
  expect(h.get("content-type")).toBe("message/rfc822");
});

test("retry with backoff, then pending, then recover", async () => {
  const fs = new FakeServer();
  fs.statuses = [503];
  const { e } = await newEngine(fs, mail("a", 120_000), mail("b", 60_000));
  const r = await e.runOnce();
  expect(r).toMatchObject({ delivered: 0, pending: 2 });
  expect(fs.bodies).toHaveLength(MAX_ATTEMPTS);
  const st = readState();
  expect(st.pending).toHaveLength(2);
  expect(Object.keys(st.items)).toHaveLength(0);
  fs.statuses = [200];
  expect((await e.runOnce()).delivered).toBe(2);
});

test("a permanent failure is skipped once", async () => {
  const fs = new FakeServer();
  fs.statuses = [401];
  const { e } = await newEngine(fs, mail("a", 60_000));
  expect((await e.runOnce()).skipped).toBe(1);
  await e.runOnce();
  expect(fs.bodies).toHaveLength(1);
});

test("an oversize item is skipped without reading it", async () => {
  const fs = new FakeServer();
  const { e, adapter } = await newEngine(fs, mail("big", 60_000, { size: MAX_BODY_BYTES + 1 }));
  expect((await e.runOnce()).skipped).toBe(1);
  expect(adapter.loaded).toEqual([]);
  expect(fs.bodies).toHaveLength(0);
});

test("known items are not read again", async () => {
  const fs = new FakeServer();
  const { e, adapter } = await newEngine(fs, mail("a", 60_000));
  await e.runOnce();
  await e.runOnce();
  expect(adapter.loaded).toEqual(["a"]);
});

test("backfill does not move the cursor", async () => {
  const fs = new FakeServer();
  const { e } = await newEngine(fs, mail("old", 48 * 3600_000));
  expect((await e.backfill(new Date(Date.now() - 72 * 3600_000))).delivered).toBe(1);
  expect(readState().cursor).toBeUndefined();
});

test("state files written by the PowerShell bridge are read", () => {
  const ps = `{"version":1,"cursor":"2026-01-02T03:04:05.0000000Z","last_run":null,"last_sweep":null,
  "items":{"ID1":{"outcome":"delivered","status":200,"at":"2026-01-02T03:04:05.0000000Z"},
  "ID2":{"outcome":"skipped","status":401,"at":"x","received":"2026-01-01T00:00:00.0000000Z"}},"pending":"ID9"}`;
  writeFileSync(join(home(), "state.json"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ps)]));
  const st = readState();
  expect(Object.keys(st.items)).toHaveLength(2);
  expect(st.pending).toEqual(["ID9"]);
});

test("enroll and revoke", async () => {
  const keys = new MemKeys();
  let cookie = "";
  let posted = "";
  const fs = new FakeServer();
  fs.other = (_u, init) => {
    if (init.method === "POST") {
      cookie = (init.headers as Record<string, string>).Cookie!;
      posted = String(init.body);
      return { status: 201, body: '{"id":"dev-1","address":"me@orbit.test","name":"PC"}' };
    }
    return { status: 204 };
  };
  const http = new Http({ fetch: fs.fetch });
  const cfg = await enroll(http, keys, { server: "https://orbit.test/", workspaceId: "ws", name: "PC", credential: { kind: "session", value: "tok" } });
  expect(cfg).toMatchObject({ device_id: "dev-1", server: "https://orbit.test" });
  expect(cookie).toBe("__Host-orbit_session=tok");
  expect(posted).toContain('"public_key"');
  await expect(enroll(http, keys, { server: "https://orbit.test", workspaceId: "ws", credential: { kind: "api", value: "t" } })).rejects.toThrow(/already enrolled/);
  await expect(revoke(http, keys, undefined, false)).rejects.toThrow(/credential/);
  await revoke(http, keys, { kind: "api", value: "t" }, false);
  expect(readConfig()).toBeUndefined();
  await expect(keys.publicKey(cfg.key_name)).rejects.toThrow();
});

test("a failed enrollment leaves no key behind", async () => {
  const keys = new MemKeys();
  const fs = new FakeServer();
  fs.other = () => ({ status: 403 });
  const http = new Http({ fetch: fs.fetch });
  await expect(enroll(http, keys, { server: "https://orbit.test", workspaceId: "ws", credential: { kind: "session", value: "x" } })).rejects.toThrow();
  expect(keys.keys.size).toBe(0);
  await expect(enroll(http, keys, { server: "http://orbit.test", workspaceId: "ws", credential: { kind: "api", value: "x" } })).rejects.toThrow(/https/);
  expect(() => assertServerURL("http://localhost:8080")).not.toThrow();
  expect(() => assertServerURL("http://127.0.0.1")).not.toThrow();
  expect(() => assertServerURL("http://example.com")).toThrow();
});

test("doctor", async () => {
  const keys = new MemKeys();
  const fs = new FakeServer();
  fs.other = (u) => (u.pathname.endsWith("/devices") ? { status: 201, body: '{"id":"d","address":"a@b.c","name":"n"}' } : { status: 200, body: "ok" });
  const http = new Http({ fetch: fs.fetch });
  expect(worst(await diagnose(http, keys))).toBe("fail"); // not enrolled
  await enroll(http, keys, { server: "https://orbit.test", workspaceId: "w", credential: { kind: "api", value: "t" } });
  const checks = await diagnose(http, keys);
  expect(checks.filter((c) => c.level === "fail")).toEqual([]);
  const cfg = readConfig()!;
  await keys.delete(cfg.key_name);
  expect(worst(await diagnose(http, keys))).toBe("fail"); // key gone
});

test("versions and checksums", () => {
  expect(compareVersions("0.4.1+3", "0.4.1+10")).toBe(-1);
  expect(compareVersions("0.5.0", "0.4.9+9")).toBe(1);
  expect(compareVersions("v0.4.1+3", "0.4.1+3")).toBe(0);
  expect(compareVersions("dev", "0.0.1")).toBe(-1);
  const data = Buffer.from("exe");
  const sums = createHash("sha256").update(data).digest("hex") + "  " + assetName("1.0.0") + "\n";
  verifySums(sums, assetName("1.0.0"), data);
  expect(() => verifySums(sums, assetName("1.0.0"), Buffer.from("evil"))).toThrow(/mismatch/);
  expect(() => verifySums(sums, "other", data)).toThrow(/no entry/);
});

test("the bridge folder holds no stray files after a sweep", async () => {
  const { e } = await newEngine(new FakeServer(), mail("a", 60_000));
  await e.runOnce();
  expect(readdirSync(home()).sort()).toEqual(["bridge.log", "state.json"]);
});
