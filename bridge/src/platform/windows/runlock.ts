import { dlopen, FFIType, ptr } from "bun:ffi";

const { ptr: P, u32, u64, i32 } = FFIType;
const SYNCHRONIZE = 0x00100000;

let k32: ReturnType<typeof load> | undefined;
function load() {
  return dlopen("kernel32.dll", {
    OpenMutexW: { args: [u32, i32, P], returns: u64 },
    CreateMutexW: { args: [P, i32, P], returns: u64 },
    CloseHandle: { args: [u64], returns: i32 },
    FreeConsole: { args: [], returns: i32 },
  }).symbols;
}
const k = () => (k32 ??= load());

const hold = (..._buffers: unknown[]): void => {};

function wstr(s: string): Uint16Array {
  const b = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

/**
 * One worker per Windows session. The mutex name is the one the earlier service worker used, so the
 * two never deliver at the same time. Returns a release function, or undefined when another worker holds it.
 */
export function acquireRunLock(): (() => void) | undefined {
  const name = wstr("Local\\TorbitBridgeRun");
  const existing = k().OpenMutexW(SYNCHRONIZE, 0, ptr(name));
  hold(name);
  if (existing !== 0n) {
    k().CloseHandle(existing);
    return undefined;
  }
  const h = k().CreateMutexW(null, 1, ptr(name));
  hold(name);
  if (h === 0n) throw new Error("could not create the run lock");
  return () => void k().CloseHandle(h);
}

/** Detaches from the console, so a logon task leaves no window behind. */
export function hideConsole(): void {
  try {
    k().FreeConsole();
  } catch {
    /* keep the console */
  }
}
