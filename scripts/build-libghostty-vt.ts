#!/usr/bin/env node

import * as Fs from "node:fs";
import * as Path from "node:path";
import * as Process from "node:process";
import { spawnSync } from "node:child_process";

const ROOT = Path.resolve(import.meta.dirname, "..");
const GHOSTTY_DIR = Path.join(ROOT, "third_party", "ghostty");
const OUTPUT_DIR = Path.join(ROOT, "apps", "web", "public", "libghostty");
const OUTPUT_FILE = Path.join(OUTPUT_DIR, "ghostty-vt.wasm");
const SOURCE_FILE = Path.join(GHOSTTY_DIR, "zig-out", "bin", "ghostty-vt.wasm");
const REQUIRED_ZIG = "0.15.2";

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: Process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "null"}`,
    );
  }
}

function readZigVersion(): string {
  const result = spawnSync("zig", ["version"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(
      `zig is required to build libghostty-vt. Install Zig ${REQUIRED_ZIG} and rerun bun run build:libghostty-vt.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`zig version failed with exit code ${result.status ?? "null"}`);
  }
  return result.stdout.trim();
}

const zigVersion = readZigVersion();
if (zigVersion !== REQUIRED_ZIG) {
  throw new Error(`libghostty-vt requires Zig ${REQUIRED_ZIG}; found ${zigVersion}.`);
}

run(
  "zig",
  ["build", "-Demit-lib-vt", "-Dtarget=wasm32-freestanding", "-Doptimize=ReleaseSmall"],
  GHOSTTY_DIR,
);

Fs.mkdirSync(OUTPUT_DIR, { recursive: true });
Fs.copyFileSync(SOURCE_FILE, OUTPUT_FILE);
console.log(`wrote ${Path.relative(ROOT, OUTPUT_FILE)}`);
