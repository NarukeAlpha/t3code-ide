import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { ProjectDetectedScriptCatalog } from "../Services/ProjectDetectedScriptCatalog.ts";
import { ProjectDetectedScriptCatalogLive } from "./ProjectDetectedScriptCatalog.ts";

const writeProjectFile = (cwd: string, relativePath: string, contents = "") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const absolutePath = path.join(cwd, relativePath);
    yield* fs.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fs.writeFileString(absolutePath, contents);
    return absolutePath;
  });

it.layer(NodeServices.layer)("ProjectDetectedScriptCatalog", (it) => {
  it.effect("lists package.json scripts without failing on bigint-backed stat metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-detected-scripts-" });
      const manifestPath = yield* writeProjectFile(
        cwd,
        "package.json",
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
      yield* writeProjectFile(cwd, "bun.lock");

      const catalog = yield* ProjectDetectedScriptCatalog;
      const first = yield* catalog.list({ cwd });
      const second = yield* catalog.list({ cwd });

      assert.deepStrictEqual(first, {
        scripts: [
          {
            id: "package_json:dev",
            source: "package_json",
            displayName: "dev",
            badgeLabel: "package.json",
            detail: "pnpm · vite",
            command: "pnpm run dev",
            originPath: manifestPath,
          },
          {
            id: "package_json:build",
            source: "package_json",
            displayName: "build",
            badgeLabel: "package.json",
            detail: "pnpm · tsc -b",
            command: "pnpm run build",
            originPath: manifestPath,
          },
        ],
        warnings: [],
      });
      assert.deepStrictEqual(second, first);
    }).pipe(Effect.provide(ProjectDetectedScriptCatalogLive)),
  );

  it.effect("adds root-only built-in defaults in stable source order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-detected-defaults-" });
      const manifestPath = yield* writeProjectFile(
        cwd,
        "package.json",
        `${JSON.stringify({ scripts: { dev: "vite" } }, null, 2)}\n`,
      );
      const zigPath = yield* writeProjectFile(cwd, "build.zig", 'const std = @import("std");\n');
      const gradlePath = yield* writeProjectFile(cwd, "build.gradle.kts", "plugins {}\n");
      yield* writeProjectFile(cwd, "gradlew", "#!/bin/sh\n");
      const goPath = yield* writeProjectFile(cwd, "go.mod", "module example.com/demo\n");
      const cargoPath = yield* writeProjectFile(cwd, "Cargo.toml", '[package]\nname = "demo"\n');
      const dotnetPath = yield* writeProjectFile(
        cwd,
        "Demo.sln",
        "Microsoft Visual Studio Solution File\n",
      );

      const catalog = yield* ProjectDetectedScriptCatalog;
      const detected = yield* catalog.list({ cwd });

      assert.deepStrictEqual(detected, {
        scripts: [
          {
            id: "package_json:dev",
            source: "package_json",
            displayName: "dev",
            badgeLabel: "package.json",
            detail: "npm · vite",
            command: "npm run dev",
            originPath: manifestPath,
          },
          {
            id: "zig:build",
            source: "zig",
            displayName: "Build",
            badgeLabel: "Zig",
            detail: "build.zig",
            command: "zig build",
            originPath: zigPath,
          },
          {
            id: "gradle:build",
            source: "gradle",
            displayName: "Build",
            badgeLabel: "Gradle",
            detail: "build.gradle.kts",
            command: "./gradlew build",
            originPath: gradlePath,
          },
          {
            id: "gradle:test",
            source: "gradle",
            displayName: "Test",
            badgeLabel: "Gradle",
            detail: "build.gradle.kts",
            command: "./gradlew test",
            originPath: gradlePath,
          },
          {
            id: "go:build",
            source: "go",
            displayName: "Build",
            badgeLabel: "Go",
            detail: "go.mod",
            command: "go build",
            originPath: goPath,
          },
          {
            id: "go:run",
            source: "go",
            displayName: "Run",
            badgeLabel: "Go",
            detail: "go.mod",
            command: "go run .",
            originPath: goPath,
          },
          {
            id: "go:test",
            source: "go",
            displayName: "Test",
            badgeLabel: "Go",
            detail: "go.mod",
            command: "go test",
            originPath: goPath,
          },
          {
            id: "rust:build",
            source: "rust",
            displayName: "Build",
            badgeLabel: "Rust",
            detail: "Cargo.toml",
            command: "cargo build",
            originPath: cargoPath,
          },
          {
            id: "rust:test",
            source: "rust",
            displayName: "Test",
            badgeLabel: "Rust",
            detail: "Cargo.toml",
            command: "cargo test",
            originPath: cargoPath,
          },
          {
            id: "dotnet:build",
            source: "dotnet",
            displayName: "Build",
            badgeLabel: ".NET",
            detail: "Demo.sln",
            command: "dotnet build",
            originPath: dotnetPath,
          },
          {
            id: "dotnet:test",
            source: "dotnet",
            displayName: "Test",
            badgeLabel: ".NET",
            detail: "Demo.sln",
            command: "dotnet test",
            originPath: dotnetPath,
          },
          {
            id: "dotnet:msbuild",
            source: "dotnet",
            displayName: "MSBuild",
            badgeLabel: ".NET",
            detail: "Demo.sln",
            command: "dotnet msbuild",
            originPath: dotnetPath,
          },
        ],
        warnings: [],
      });
    }).pipe(Effect.provide(ProjectDetectedScriptCatalogLive)),
  );

  it.effect("prefers gradlew when present and falls back to gradle otherwise", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const wrapperCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gradle-wrapper-" });
      yield* writeProjectFile(wrapperCwd, "build.gradle", 'apply plugin: "java"\n');
      yield* writeProjectFile(wrapperCwd, "gradlew", "#!/bin/sh\n");

      const fallbackCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gradle-cli-" });
      yield* writeProjectFile(fallbackCwd, "build.gradle.kts", "plugins {}\n");

      const catalog = yield* ProjectDetectedScriptCatalog;
      const wrapperDetected = yield* catalog.list({ cwd: wrapperCwd });
      const fallbackDetected = yield* catalog.list({ cwd: fallbackCwd });

      assert.deepStrictEqual(
        wrapperDetected.scripts.map((script) => script.command),
        ["./gradlew build", "./gradlew test"],
      );
      assert.deepStrictEqual(
        fallbackDetected.scripts.map((script) => script.command),
        ["gradle build", "gradle test"],
      );
    }).pipe(Effect.provide(ProjectDetectedScriptCatalogLive)),
  );

  it.effect("ignores nested ecosystem markers and keeps detection root-only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-root-only-" });
      yield* writeProjectFile(cwd, "nested/go.mod", "module example.com/nested\n");
      yield* writeProjectFile(cwd, "nested/Cargo.toml", '[package]\nname = "nested"\n');
      yield* writeProjectFile(cwd, "nested/.cargo/config.toml", '[build]\ntarget-dir = "target"\n');
      yield* writeProjectFile(cwd, "nested/App.csproj", "<Project />\n");

      const catalog = yield* ProjectDetectedScriptCatalog;
      const detected = yield* catalog.list({ cwd });

      assert.deepStrictEqual(detected, {
        scripts: [],
        warnings: [],
      });
    }).pipe(Effect.provide(ProjectDetectedScriptCatalogLive)),
  );

  it.effect("keeps non-package defaults available when package.json is invalid", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-invalid-package-json-" });
      yield* writeProjectFile(cwd, "package.json", "{ invalid json\n");
      const goPath = yield* writeProjectFile(cwd, "go.mod", "module example.com/demo\n");

      const catalog = yield* ProjectDetectedScriptCatalog;
      const detected = yield* catalog.list({ cwd });

      assert.deepStrictEqual(detected, {
        scripts: [
          {
            id: "go:build",
            source: "go",
            displayName: "Build",
            badgeLabel: "Go",
            detail: "go.mod",
            command: "go build",
            originPath: goPath,
          },
          {
            id: "go:run",
            source: "go",
            displayName: "Run",
            badgeLabel: "Go",
            detail: "go.mod",
            command: "go run .",
            originPath: goPath,
          },
          {
            id: "go:test",
            source: "go",
            displayName: "Test",
            badgeLabel: "Go",
            detail: "go.mod",
            command: "go test",
            originPath: goPath,
          },
        ],
        warnings: [
          {
            message:
              "package.json could not be parsed. JavaScript package scripts are unavailable.",
          },
        ],
      });
    }).pipe(Effect.provide(ProjectDetectedScriptCatalogLive)),
  );

  it.effect("detects rust defaults from root .cargo/config.toml when Cargo.toml is absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-rust-config-root-" });
      const cargoConfigPath = yield* writeProjectFile(
        cwd,
        ".cargo/config.toml",
        '[build]\ntarget-dir = "target"\n',
      );

      const catalog = yield* ProjectDetectedScriptCatalog;
      const detected = yield* catalog.list({ cwd });

      assert.deepStrictEqual(detected, {
        scripts: [
          {
            id: "rust:build",
            source: "rust",
            displayName: "Build",
            badgeLabel: "Rust",
            detail: ".cargo/config.toml",
            command: "cargo build",
            originPath: cargoConfigPath,
          },
          {
            id: "rust:test",
            source: "rust",
            displayName: "Test",
            badgeLabel: "Rust",
            detail: ".cargo/config.toml",
            command: "cargo test",
            originPath: cargoConfigPath,
          },
        ],
        warnings: [],
      });
    }).pipe(Effect.provide(ProjectDetectedScriptCatalogLive)),
  );
});
