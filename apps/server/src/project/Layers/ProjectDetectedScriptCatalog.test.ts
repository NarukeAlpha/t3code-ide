import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { ProjectDetectedScriptCatalog } from "../Services/ProjectDetectedScriptCatalog.ts";
import { ProjectDetectedScriptCatalogLive } from "./ProjectDetectedScriptCatalog.ts";

it.layer(NodeServices.layer)("ProjectDetectedScriptCatalog", (it) => {
  it.effect("lists package scripts without failing on bigint-backed stat metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-detected-scripts-" });
      const manifestPath = path.join(cwd, "package.json");

      yield* fs.writeFileString(
        manifestPath,
        `${JSON.stringify(
          {
            packageManager: "pnpm@9.0.0",
            scripts: {
              dev: "vite",
              build: "tsc -b",
            },
          },
          null,
          2,
        )}\n`,
      );
      yield* fs.writeFileString(path.join(cwd, "bun.lock"), "");

      const catalog = yield* ProjectDetectedScriptCatalog;
      const first = yield* catalog.list({ cwd });
      const second = yield* catalog.list({ cwd });

      assert.deepStrictEqual(first, {
        scripts: [
          {
            id: "package_json:dev",
            source: "package_json",
            packageManager: "pnpm",
            scriptName: "dev",
            displayName: "dev",
            command: "pnpm run dev",
            scriptCommand: "vite",
            manifestPath,
          },
          {
            id: "package_json:build",
            source: "package_json",
            packageManager: "pnpm",
            scriptName: "build",
            displayName: "build",
            command: "pnpm run build",
            scriptCommand: "tsc -b",
            manifestPath,
          },
        ],
        warnings: [],
      });
      assert.deepStrictEqual(second, first);
    }).pipe(Effect.provide(ProjectDetectedScriptCatalogLive)),
  );
});
