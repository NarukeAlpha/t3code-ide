import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runProcess } from "./processRunner.ts";

function createMockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  child.pid = 1234;
  return child;
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("runProcess", () => {
  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], { maxBufferBytes: 128 }),
    ).rejects.toThrow("exceeded stdout buffer limit");
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
      maxBufferBytes: 128,
      outputMode: "truncate",
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });

  it("honors explicit shell overrides", async () => {
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
      spawnSync: vi.fn(),
    }));
    const child = createMockChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("close", 0, null);
      });
      return child;
    });

    const { runProcess: mockedRunProcess } = await import("./processRunner.ts");
    await mockedRunProcess("node", ["-v"], { shell: false });

    expect(spawnMock).toHaveBeenCalledWith(
      "node",
      ["-v"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("preserves default shell behavior when no override is provided", async () => {
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
      spawnSync: vi.fn(),
    }));
    const child = createMockChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("close", 0, null);
      });
      return child;
    });

    const { runProcess: mockedRunProcess } = await import("./processRunner.ts");
    await mockedRunProcess("node", ["-v"]);

    expect(spawnMock).toHaveBeenCalledWith(
      "node",
      ["-v"],
      expect.objectContaining({ shell: process.platform === "win32" }),
    );
  });
});
