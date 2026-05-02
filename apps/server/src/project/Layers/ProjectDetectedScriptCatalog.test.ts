import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ProjectDetectedScriptCatalog } from "../Services/ProjectDetectedScriptCatalog.ts";
import { ProjectDetectedScriptCatalogLive } from "./ProjectDetectedScriptCatalog.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";

const ProjectDetectedScriptCatalogTestLayer = ProjectDetectedScriptCatalogLive.pipe(
  Layer.provide(WorkspacePathsLive),
);

it.layer(NodeServices.layer)("ProjectDetectedScriptCatalogLive", (it) => {
  it.effect("prefers the packageManager field over lockfile inference", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-project-detected-scripts-package-manager-",
      });

      yield* fs.writeFileString(
        path.join(cwd, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@10.0.0",
          scripts: {
            dev: "vite",
          },
        }),
      );
      yield* fs.writeFileString(path.join(cwd, "bun.lock"), "");

      const catalog = yield* ProjectDetectedScriptCatalog;
      const result = yield* catalog.list({ cwd });

      expect(result.scripts).toHaveLength(1);
      expect(result.scripts[0]).toMatchObject({
        source: "package_json",
        displayName: "dev",
        badgeLabel: "js",
        command: "pnpm run dev",
        detail: "pnpm · vite",
      });
      expect(result.warnings).toEqual([]);
    }).pipe(Effect.provide(ProjectDetectedScriptCatalogTestLayer)),
  );

  it.effect("labels package scripts as ts when package.json clearly indicates TypeScript", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-project-detected-scripts-typescript-badge-",
      });

      yield* fs.writeFileString(
        path.join(cwd, "package.json"),
        JSON.stringify({
          devDependencies: {
            typescript: "^5.9.0",
          },
          scripts: {
            build: "tsc -b",
          },
        }),
      );

      const catalog = yield* ProjectDetectedScriptCatalog;
      const result = yield* catalog.list({ cwd });

      expect(result.scripts).toHaveLength(1);
      expect(result.scripts[0]).toMatchObject({
        source: "package_json",
        badgeLabel: "ts",
        displayName: "build",
        command: "npm run build",
      });
    }).pipe(Effect.provide(ProjectDetectedScriptCatalogTestLayer)),
  );

  it.effect("returns non-JS defaults even when package.json is invalid", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-project-detected-scripts-invalid-package-json-",
      });

      yield* fs.writeFileString(path.join(cwd, "package.json"), "{ invalid");
      yield* fs.writeFileString(path.join(cwd, "build.zig"), "pub fn build() void {}\n");

      const catalog = yield* ProjectDetectedScriptCatalog;
      const result = yield* catalog.list({ cwd });

      expect(result.scripts.map((script) => script.source)).toEqual(["zig"]);
      expect(result.scripts[0]).toMatchObject({
        displayName: "Build",
        command: "zig build",
      });
      expect(result.warnings).toEqual(['Could not parse "package.json".']);
    }).pipe(Effect.provide(ProjectDetectedScriptCatalogTestLayer)),
  );

  it.effect("keeps detection root-scoped", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-project-detected-scripts-root-only-",
      });

      yield* fs.makeDirectory(path.join(cwd, "packages", "app"), { recursive: true });
      yield* fs.writeFileString(
        path.join(cwd, "packages", "app", "go.mod"),
        "module example/app\n",
      );
      yield* fs.writeFileString(
        path.join(cwd, "packages", "app", "package.json"),
        JSON.stringify({ scripts: { dev: "vite" } }),
      );

      const catalog = yield* ProjectDetectedScriptCatalog;
      const result = yield* catalog.list({ cwd });

      expect(result.scripts).toEqual([]);
      expect(result.warnings).toEqual([]);
    }).pipe(Effect.provide(ProjectDetectedScriptCatalogTestLayer)),
  );

  it.effect("prefers the Gradle wrapper command while describing the build file origin", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-project-detected-scripts-gradle-wrapper-",
      });

      yield* fs.writeFileString(path.join(cwd, "gradlew"), "#!/bin/sh\n");
      yield* fs.writeFileString(path.join(cwd, "build.gradle.kts"), "plugins {}\n");

      const catalog = yield* ProjectDetectedScriptCatalog;
      const result = yield* catalog.list({ cwd });

      expect(result.scripts.map((script) => script.command)).toEqual([
        "./gradlew build",
        "./gradlew test",
      ]);
      expect(result.scripts.every((script) => script.detail === "Gradle · build.gradle.kts")).toBe(
        true,
      );
    }).pipe(Effect.provide(ProjectDetectedScriptCatalogTestLayer)),
  );

  it.effect("detects Rust defaults from a root .cargo/config.toml", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-project-detected-scripts-rust-config-",
      });

      yield* fs.makeDirectory(path.join(cwd, ".cargo"), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, ".cargo", "config.toml"), "[build]\n");

      const catalog = yield* ProjectDetectedScriptCatalog;
      const result = yield* catalog.list({ cwd });

      expect(result.scripts).toHaveLength(2);
      expect(result.scripts.map((script) => script.source)).toEqual(["rust", "rust"]);
      expect(result.scripts.map((script) => script.command)).toEqual(["cargo build", "cargo test"]);
      expect(result.scripts.every((script) => script.originPath === ".cargo/config.toml")).toBe(
        true,
      );
    }).pipe(Effect.provide(ProjectDetectedScriptCatalogTestLayer)),
  );
});
