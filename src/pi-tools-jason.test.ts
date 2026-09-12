import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readManyFilesTool,
  sandboxShellArgs,
  sandboxShellEnvironment,
} from "./pi-tools.js";

assert.deepEqual(
  sandboxShellArgs("devspace-coding", "/workspace/project", "npm test", 30),
  [
    "exec",
    "-w",
    "/workspace/project",
    "devspace-coding",
    "/usr/bin/timeout",
    "--signal=TERM",
    "--kill-after=2s",
    "30s",
    "/bin/bash",
    "-lc",
    "npm test",
  ],
);

assert.deepEqual(
  sandboxShellEnvironment({ PATH: "/bin", SSH_AUTH_SOCK: "/private/agent.sock" }),
  { PATH: "/bin" },
);

const root = mkdtempSync(join(tmpdir(), "devspace-read-many-"));
try {
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "a.txt"), "alpha\n");
  writeFileSync(join(root, "nested", "b.txt"), "beta\n");

  const result = await readManyFilesTool(
    {
      files: [
        { path: join(root, "a.txt"), displayPath: "a.txt", readRoots: [root] },
        { path: join(root, "nested", "b.txt"), displayPath: "nested/b.txt", readRoots: [root] },
      ],
    },
    { cwd: root, root },
  );

  assert.equal(result.isError, undefined);
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert.match(text, /--- a\.txt ---/);
  assert.match(text, /alpha/);
  assert.match(text, /--- nested\/b\.txt ---/);
  assert.match(text, /beta/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
