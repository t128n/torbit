/** The manual proxy of the signed-in user (Settings, Network, Proxy). PAC/WPAD scripts and proxy sign-in with the Windows account are not supported. */
export interface InternetSettings { enabled: boolean; server: string; override: string }

export function parseRegQuery(text: string): InternetSettings {
  const v: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+(\w+)\s+REG_\w+\s*(.*)$/.exec(line);
    if (m) v[m[1]!] = m[2]!.trim();
  }
  return { enabled: Number(v.ProxyEnable ?? 0) !== 0, server: v.ProxyServer ?? "", override: v.ProxyOverride ?? "" };
}

export function bypassed(host: string, override: string): boolean {
  const h = host.toLowerCase();
  for (const raw of override.split(/[;,]/)) {
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    if (p === "<local>") {
      if (!h.includes(".")) return true;
    } else if (p.startsWith("*")) {
      if (h.endsWith(p.slice(1))) return true;
    } else if (p.endsWith("*")) {
      if (h.startsWith(p.slice(0, -1))) return true;
    } else if (p === h) {
      return true;
    }
  }
  return false;
}

/** The proxy URL for `target` from the Windows settings, or undefined. */
export function proxyFromSettings(s: InternetSettings, target: URL): string | undefined {
  if (!s.enabled || !s.server) return undefined;
  if (bypassed(target.hostname, s.override)) return undefined;
  let chosen = s.server;
  if (chosen.includes("=")) { // per-scheme list: http=h:80;https=h:443
    chosen = "";
    for (const part of s.server.split(";")) {
      const i = part.indexOf("=");
      if (i > 0 && part.slice(0, i).toLowerCase() === target.protocol.replace(":", "")) chosen = part.slice(i + 1);
    }
    if (!chosen) return undefined;
  }
  if (!chosen.includes("://")) chosen = "http://" + chosen;
  try {
    return new URL(chosen).toString();
  } catch {
    return undefined;
  }
}

/** fetch honors HTTPS_PROXY / HTTP_PROXY / NO_PROXY by itself, so the Windows settings are only a fallback. */
export const hasEnvProxy = (): boolean =>
  ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some((k) => !!process.env[k]);

let cache: { at: number; value: InternetSettings } | undefined;

/** Read through reg.exe at most every 5 minutes, so a long-running bridge notices a changed proxy. */
export function readInternetSettings(): InternetSettings {
  if (cache && Date.now() - cache.at < 300_000) return cache.value;
  let value: InternetSettings = { enabled: false, server: "", override: "" };
  try {
    const r = Bun.spawnSync(["reg.exe", "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode === 0) value = parseRegQuery(r.stdout.toString());
  } catch {
    /* no proxy */
  }
  cache = { at: Date.now(), value };
  return value;
}
