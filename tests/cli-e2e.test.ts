import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const CLI = new URL("../dist/bin.js", import.meta.url).pathname;

describe.skipIf(!existsSync(CLI))("cli e2e (built dist/bin.js)", () => {
  it("exits 0 on --help and prints usage on stdout", async () => {
    const { stdout } = await run("node", [CLI, "--help"]);
    expect(stdout).toContain("local-deep-researcher");
    expect(stdout).toContain("--max-loops");
  });

  it("exits 0 on --version", async () => {
    const { stdout } = await run("node", [CLI, "--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exits 1 on missing topic with error on stderr", async () => {
    await expect(run("node", [CLI])).rejects.toMatchObject({ code: 1 });
  });

  it("exits 1 on missing API key for tavily", async () => {
    await expect(
      run("node", [CLI, "topic", "--search-api", "tavily"], {
        env: { ...process.env, TAVILY_API_KEY: "" },
      }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("works when invoked through a symlink (npm bin scenario)", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "ldr-bin-"));
    const link = join(dir, "local-deep-researcher");
    await fs.symlink(CLI, link);
    try {
      const { stdout } = await run("node", [link, "--version"]);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
