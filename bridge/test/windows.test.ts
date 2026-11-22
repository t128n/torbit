import { expect, test } from "bun:test";
import { parseDuration } from "../src/cli.ts";
import { explainOutlookError } from "../src/platform/windows/outlook.ts";
import { bypassed, parseRegQuery, proxyFromSettings } from "../src/platform/windows/proxy.ts";
import { taskXml } from "../src/platform/windows/scheduler.ts";

test("task XML runs at logon for one user, unelevated, without a time limit", () => {
  const xml = taskXml({ exe: "C:\\Users\\Zoë & Co\\bin\\torbit-bridge.exe", args: "run --background --interval 60", user: "PC\\zoe", workDir: "C:\\Users\\x" });
  expect(xml).toContain("<LogonTrigger>");
  expect(xml).toContain("<UserId>PC\\zoe</UserId>");
  expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
  expect(xml).toContain("Zoë &amp; Co");
  expect(xml).toContain("<Arguments>run --background --interval 60</Arguments>");
});

test("proxy settings from reg.exe output", () => {
  const s = parseRegQuery(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=a:80;https=b:443
    ProxyOverride    REG_SZ    <local>;*.corp.example;10.*
`);
  expect(s).toEqual({ enabled: true, server: "http=a:80;https=b:443", override: "<local>;*.corp.example;10.*" });
  expect(proxyFromSettings(s, new URL("https://orbit.example.com/x"))).toBe("http://b:443/");
  expect(proxyFromSettings({ ...s, server: "proxy:8080" }, new URL("https://orbit.example.com"))).toBe("http://proxy:8080/");
  expect(proxyFromSettings(s, new URL("https://intranet/x"))).toBeUndefined(); // <local>
  expect(proxyFromSettings(s, new URL("https://a.corp.example"))).toBeUndefined();
  expect(proxyFromSettings({ ...s, enabled: false }, new URL("https://orbit.example.com"))).toBeUndefined();
  expect(bypassed("10.1.2.3", "10.*")).toBe(true);
});

test("COM errors say what to do", () => {
  expect(explainOutlookError(-2147221164)).toContain("not installed"); // 0x80040154
  expect(explainOutlookError(-2147024891)).toContain("blocked"); // 0x80070005
  expect(explainOutlookError(1)).toContain("could not talk");
});

test("intervals", () => {
  expect(parseDuration("60")).toBe(60_000);
  expect(parseDuration("1m30s")).toBe(90_000);
  expect(() => parseDuration("soon")).toThrow();
});
