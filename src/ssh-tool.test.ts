import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lockSshAdmin,
  normalizeSshHosts,
  resolveSshHost,
  runSshTool,
  sshAdminUnlockStatus,
  sshArgsForHost,
  unlockSshAdmin,
} from "./ssh-tool.js";

const normalized = normalizeSshHosts([
  {
    name: "prod-web_1",
    aliases: ["Prod-Web", "production"],
    host: "example.com",
    user: "deploy",
    port: 2222,
    identityFile: "~/.ssh/id_ed25519_test_fixture",
  },
]);

assert.equal(normalized[0]?.name, "prod-web_1");
assert.equal(normalized[0]?.host, "example.com");
assert.equal(normalized[0]?.user, "deploy");
assert.equal(normalized[0]?.port, 2222);
assert.equal(resolveSshHost("PROD-WEB", normalized)?.name, "prod-web_1");
assert.equal(resolveSshHost("production", normalized)?.name, "prod-web_1");
assert.equal(
  (normalized[0]?.identityFile ?? "").endsWith(join(".ssh", "id_ed25519_test_fixture")),
  true,
);

const admin = normalizeSshHosts([
  { name: "prod-root", host: "root.example.com", user: "root", tier: "admin" },
]);
assert.equal(admin[0]?.tier, "admin");

assert.deepEqual(
  sshArgsForHost(normalized[0]!, "uptime"),
  [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-p",
    "2222",
    ...(process.platform === "darwin" ? ["-o", "UseKeychain=yes"] : []),
    "-o",
    "IdentitiesOnly=yes",
    "-i",
    normalized[0]!.identityFile!,
    "--",
    "deploy@example.com",
    "uptime",
  ],
);

assert.throws(
  () => normalizeSshHosts([{ name: "bad host", host: "example.com" }]),
  /Invalid SSH host name/,
);
assert.throws(
  () => normalizeSshHosts([{ name: "x", host: "example.com", port: 0 }]),
  /Invalid SSH port/,
);
assert.throws(
  () => normalizeSshHosts([{ name: "x", host: "-oProxyCommand=bad" }]),
  /Invalid SSH host target/,
);
assert.throws(
  () => normalizeSshHosts([{ name: "x", host: "example.com", user: "bad user" }]),
  /Invalid SSH user/,
);
assert.throws(
  () => normalizeSshHosts([{ name: "x", host: "example.com", tier: "break-glass" as "admin" }]),
  /Invalid SSH tier/,
);
assert.throws(
  () => normalizeSshHosts([{ name: "x", host: "a" }, { name: "x", host: "b" }]),
  /Duplicate SSH host name/,
);
assert.throws(
  () => normalizeSshHosts([{ name: "Prod", host: "a" }, { name: "prod", host: "b" }]),
  /Duplicate SSH host name/,
);
assert.throws(
  () => normalizeSshHosts([
    { name: "Prod", host: "a", aliases: ["production"] },
    { name: "other", host: "b", aliases: ["PRODUCTION"] },
  ]),
  /Duplicate SSH alias/,
);

assert.equal((await runSshTool({ host: "prod", command: "uptime" }, [])).isError, true);
assert.equal((await runSshTool({ host: "missing", command: "uptime" }, normalized)).isError, true);
assert.equal((await runSshTool({ host: "prod-web_1", command: "" }, normalized)).isError, true);

const defaultLockedAdmin = await runSshTool(
  { host: "prod-root", command: "uptime" },
  admin,
);
assert.equal(defaultLockedAdmin.isError, true);
assert.match(
  defaultLockedAdmin.content[0]?.type === "text" ? defaultLockedAdmin.content[0].text : "",
  /locally locked/,
);

const unlockDir = mkdtempSync(join(tmpdir(), "devspace-ssh-unlock-"));
try {
  const unlockPath = join(unlockDir, "ssh-admin-unlock.json");
  const directResponse = await runSshTool(
    { host: "prod-root", command: "" },
    admin,
    { adminPolicy: "direct", adminUnlockPath: unlockPath },
  );
  assert.equal(directResponse.isError, true);
  assert.match(directResponse.content[0]?.type === "text" ? directResponse.content[0].text : "", /must not be empty/);

  const lockedResponse = await runSshTool(
    { host: "prod-root", command: "uptime" },
    admin,
    { adminPolicy: "timed-unlock", adminUnlockPath: unlockPath },
  );
  assert.equal(lockedResponse.isError, true);
  assert.match(
    lockedResponse.content[0]?.type === "text" ? lockedResponse.content[0].text : "",
    /locally locked/,
  );

  assert.equal(unlockSshAdmin(unlockPath, 15, 1_000), 1_900);
  if (process.platform !== "win32") {
    assert.equal(statSync(unlockPath).mode & 0o777, 0o600);
  }
  assert.deepEqual(sshAdminUnlockStatus(unlockPath, 1_100), {
    unlocked: true,
    expiresAt: 1_900,
    remainingSeconds: 800,
  });
  assert.equal(sshAdminUnlockStatus(unlockPath, 1_901).unlocked, false);
  lockSshAdmin(unlockPath);
  assert.equal(sshAdminUnlockStatus(unlockPath).unlocked, false);
  assert.throws(() => unlockSshAdmin(unlockPath, 16), /between 1 and 15/);
} finally {
  rmSync(unlockDir, { recursive: true, force: true });
}
