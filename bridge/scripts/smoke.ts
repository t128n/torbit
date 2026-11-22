// Smoke test of the built exe on a real Windows machine (CI): bun run scripts/smoke.ts dist/torbit-bridge.exe
// It enrolls against a fake local Orbit (real CNG key), then registers and removes the logon task.
// There is no Outlook on a CI runner, so the Outlook check is expected to fail.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2] ?? "dist/torbit-bridge.exe");
const home = mkdtempSync(join(tmpdir(), "torbit-smoke-"));
const mcpHome = mkdtempSync(join(tmpdir(), "torbit-smoke-mcp-"));

// A stand-in msoutlook-mcp: setup/doctor/install only need a reachable daemon and one list_mail.
const mcp = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/health") {
      return Response.json({ status: "connected", version: "0.2.0", lastSuccessfulPoll: null, outlook: { state: "connected" } });
    }
    if (u.pathname !== "/mcp") return new Response("not found", { status: 404 });
    if (req.headers.get("authorization") !== "Bearer smoke-mcp-token") {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const msg = (await req.json()) as { id?: number; method?: string; params?: { name?: string } };
    if (msg.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "msoutlook-mcp", version: "0.2.0" } },
      });
    }
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const data = msg.params?.name === "list_mail" ? { items: [], truncated: false } : {};
    return Response.json({
      jsonrpc: "2.0",
      id: msg.id,
      result: { resultType: "complete", content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data },
    });
  },
});
writeFileSync(join(mcpHome, "config.json"), JSON.stringify({ version: 1, port: mcp.port }));
writeFileSync(join(mcpHome, "token"), "smoke-mcp-token\n");

// install ensures the dependency's logon task exists. A runner has no real msoutlook-mcp exe,
// so register a harmless task with the same name; the fake daemon stays the /health source.
const MCP_TASK = "MSOutlook MCP";
Bun.spawnSync(["schtasks.exe", "/Delete", "/TN", MCP_TASK, "/F"], { stdout: "ignore", stderr: "ignore" });
const mcpTask = Bun.spawnSync(
  ["schtasks.exe", "/Create", "/TN", MCP_TASK, "/SC", "ONLOGON", "/TR", "cmd.exe /d /c exit 0", "/F"],
  { stdout: "pipe", stderr: "pipe" },
);

const env = {
  ...process.env,
  TORBIT_BRIDGE_HOME: home,
  MSOUTLOOK_MCP_HOME: mcpHome,
  TORBIT_API_TOKEN: "smoke-token",
};

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/health/live") return new Response("ok");
    if (req.method === "POST" && u.pathname.endsWith("/mail/bridge/devices")) {
      return Response.json({ id: "00000000-0000-4000-8000-000000000001", address: "smoke@bridge.invalid", name: "smoke" }, { status: 201 });
    }
    return new Response(null, { status: 204 });
  },
});

// Async on purpose: the fake Orbit runs in this process, so it must keep serving while the exe runs.
async function bridge(...args: string[]) {
  const p = Bun.spawn([exe, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const text = stdout + stderr;
  console.log(`\n> torbit-bridge ${args.join(" ")}  (exit ${code})\n${text}`);
  return { code, text };
}

let failed = "";
const expect = (cond: boolean, what: string) => {
  if (!cond && !failed) failed = what;
};

try {
  expect((await bridge("version", "--short")).code === 0, "version");
  const setup = await bridge("setup", "--no-task", "--server", `http://localhost:${server.port}`, "--workspace", "smoke");
  expect(setup.text.includes("Enrolled."), "setup enrolls with a CNG key");
  const doctor = await bridge("doctor");
  expect(/\[ ok \] Signing key\s+.*signs and verifies/.test(doctor.text), "doctor: the CNG key signs and verifies");
  expect(/\[ ok \] Orbit server/.test(doctor.text), "doctor: reaches the fake Orbit");
  expect(mcpTask.exitCode === 0, "the fake MSOutlook MCP logon task is registered");

  const install = await bridge("install", "--no-start");
  expect(install.code === 0, "install registers the logon task");
  const query = Bun.spawnSync(["schtasks.exe", "/Query", "/TN", "Torbit Bridge", "/XML"], { stdout: "pipe" }).stdout.toString();
  console.log(query);
  expect(query.includes("<LogonTrigger>") && query.includes("run --background"), "the task has a logon trigger and runs `run --background`");
  expect((await bridge("doctor")).text.includes('[ ok ] Logon task'), "doctor sees the logon task");

  const uninstall = await bridge("uninstall", "--purge");
  expect(uninstall.code === 0, "uninstall --purge");
  const gone = Bun.spawnSync(["schtasks.exe", "/Query", "/TN", "Torbit Bridge"], { stdout: "ignore", stderr: "ignore" }).exitCode;
  expect(gone !== 0, "the logon task is removed");
} finally {
  server.stop(true);
  mcp.stop(true);
  Bun.spawnSync(["schtasks.exe", "/Delete", "/TN", "Torbit Bridge", "/F"], { stdout: "ignore", stderr: "ignore" });
  Bun.spawnSync(["schtasks.exe", "/Delete", "/TN", MCP_TASK, "/F"], { stdout: "ignore", stderr: "ignore" });
  try { rmSync(home, { recursive: true, force: true }); } catch { /* the removed exe may still be exiting */ }
  try { rmSync(mcpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failed) {
  console.error(`\nSMOKE TEST FAILED: ${failed}`);
  process.exit(1);
}
console.log("\nSmoke test passed.");
