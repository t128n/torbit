import { createHash } from "node:crypto";
import type { Http } from "./http.ts";
import { errText } from "./util.ts";

/** The part of a GitHub release the upgrade command needs. */
export interface Release {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

export const releaseVersion = (r: Release): string => r.tag_name.replace(/^torbit-v/, "");
export const releaseAsset = (r: Release, name: string): string => r.assets.find((a) => a.name === name)?.browser_download_url ?? "";

/** The standalone bridge binary attached to each release. */
export const assetName = (version: string): string => `torbit-bridge-windows-x86_64-${version}.exe`;

/** Fetches the newest release (or a specific version) of `repo`. */
export async function latestRelease(http: Http, repo: string, version = ""): Promise<Release> {
  const base = `https://api.github.com/repos/${repo}/releases`;
  const url = version ? `${base}/tags/torbit-v${version.replace(/^v/, "")}` : `${base}/latest`;
  const res = await http.do("GET", url, { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 0) throw new Error("could not reach GitHub: " + errText(res.err));
  if (res.status === 404) throw new Error("no such release found");
  if (res.status !== 200) throw new Error(`GitHub answered ${res.status}`);
  return JSON.parse(res.body) as Release;
}

/** Checks `data` against the SHA256SUMS text for `name`. */
export function verifySums(sums: string, name: string, data: Uint8Array): void {
  let want = "";
  for (const line of sums.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length === 2 && f[1]!.replace(/^\*/, "") === name) want = f[0]!.toLowerCase();
  }
  if (!want) throw new Error(`SHA256SUMS has no entry for ${name}`);
  if (createHash("sha256").update(data).digest("hex") !== want) {
    throw new Error("checksum mismatch; the download is damaged or was tampered with");
  }
}

const RE_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?/;

function parseVersion(v: string): number[] {
  const m = RE_VERSION.exec(v);
  return m ? [1, 2, 3, 4].map((i) => Number(m[i] ?? 0)) : [-1, 0, 0, 0];
}

/** Compares "major.minor.patch+build" strings (the VERSION file format): -1, 0 or 1. Unparseable versions (a dev build) sort lowest. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}
