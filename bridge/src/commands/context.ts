import { Http } from "../core/http.ts";
import type { Platform } from "../core/types.ts";
import { createPlatform } from "../platform/index.ts";

export interface Ctx { platform: Platform; http: Http }

export function createContext(): Ctx {
  const platform = createPlatform();
  return { platform, http: new Http({ platform }) };
}

export type Command = (args: string[], ctx: Ctx) => Promise<number>;
