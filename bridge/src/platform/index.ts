import type { Adapter, Platform } from "../core/types.ts";
import { FileKeys } from "./fileKeys.ts";
import { CngKeys } from "./windows/cng.ts";
import { OutlookAdapter } from "./windows/outlook.ts";
import { hasEnvProxy, proxyFromSettings, readInternetSettings } from "./windows/proxy.ts";
import { acquireRunLock } from "./windows/runlock.ts";

export const isWindows = process.platform === "win32";

/** The bridge built into one executable runs from that exe; `bun src/main.ts` runs from bun itself. */
export const isCompiled = (): boolean => !/^bun(-profile)?(\.exe)?$/i.test(process.execPath.split(/[\\/]/).pop() ?? "");

/**
 * Windows: CNG key, Outlook through COM, proxy from the Windows settings. Other systems get development
 * stubs (a file key, no Outlook) so the rest can be built, enrolled and tested on Linux and macOS.
 * Everything that touches Windows APIs is loaded lazily, so importing this file is safe everywhere.
 */
export function createPlatform(): Platform {
  if (!isWindows) {
    const keys = new FileKeys();
    return {
      supported: false,
      keys: () => keys,
      newOutlook: async (): Promise<Adapter> => { throw new Error("Outlook automation is only available on Windows"); },
      proxyFor: () => undefined,
      runLock: () => () => {},
    };
  }
  const keys = new CngKeys();
  return {
    supported: true,
    keys: () => keys,
    newOutlook: async (opts) => new OutlookAdapter(opts?.timeoutMs),
    proxyFor: (url) => (hasEnvProxy() ? undefined : proxyFromSettings(readInternetSettings(), url)),
    runLock: acquireRunLock,
  };
}
