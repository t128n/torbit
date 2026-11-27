// Builds the bridge into one Windows executable: bun run build  ->  dist/torbit-bridge.exe
// Needs only Bun. It cross-compiles, so it also works on Linux and macOS.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const version = (process.argv[2] ?? readFileSync(join(root, "..", "VERSION"), "utf8")).trim();
if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error(`invalid version '${version}'`);

// "0.4.1+3" -> "0.4.1.3" for the Windows file version resource
const m = /^(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?/.exec(version);
const fileVersion = m ? `${m[1]}.${m[2]}.${m[3]}.${m[4] ?? 0}` : "0.0.0.0";

const outfile = join(root, "dist", "torbit-bridge.exe");
mkdirSync(join(root, "dist"), { recursive: true });

console.log(`Building torbit-bridge.exe ${version}`);
const proc = Bun.spawn(
  [
    process.execPath, "build", "--compile", "--target=bun-windows-x64", "--minify",
    // A tool that runs from any folder must not pick up .env or bunfig.toml files from it.
    "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
    `--define`, `BUILD_VERSION=${JSON.stringify(version)}`,
    // File properties can only be written when building on Windows (CI does).
    ...(process.platform === "win32"
      ? ["--windows-hide-console", "--windows-title", "torbit-bridge", "--windows-description", "Outlook to Torbit/Orbit mail bridge", "--windows-version", fileVersion]
      : []),
    join(root, "src", "main.ts"), "--outfile", outfile,
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if ((await proc.exited) !== 0) throw new Error("bun build failed");
console.log(`Built ${outfile}`);
