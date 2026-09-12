import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FixedWindowRateLimiter,
  findProtectedWorkspacePath,
  isProtectedWorkspacePath,
  parseEnvironmentAllowlist,
  redactSensitiveText,
  sanitizeExecutionEnvironment,
  sanitizeLogFields,
} from "./security.js";

test("fixed-window rate limiter resets cleanly after the configured window", () => {
  const limiter = new FixedWindowRateLimiter(2, 1_000);
  assert.deepEqual(limiter.consume("client", 0), { allowed: true, retryAfterSeconds: 1 });
  assert.deepEqual(limiter.consume("client", 100), { allowed: true, retryAfterSeconds: 1 });
  assert.equal(limiter.consume("client", 200).allowed, false);
  assert.deepEqual(limiter.consume("client", 1_000), { allowed: true, retryAfterSeconds: 1 });
});

test("protected workspace paths cover common local credential files", () => {
  const root = join(tmpdir(), "devspace-security-root");
  for (const path of [
    ".env",
    ".env.local",
    ".env.production",
    "wp-config.php",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    "auth.json",
    "credentials.json",
    "service-account.json",
    "application_default_credentials.json",
    "private.pem",
    "client.key",
    "keystore.p12",
    "keystore.pfx",
    "keystore.jks",
    ".ssh/id_ed25519",
    ".aws/credentials",
    ".gnupg/private-keys-v1.d/key",
    ".trigger-tree/history.jsonl",
    ".trigger-tree/sessions/run.jsonl",
  ]) {
    assert.equal(isProtectedWorkspacePath(join(root, path), root), true, path);
  }

  for (const path of [
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
    "wp-config-sample.php",
    "src/config.ts",
  ]) {
    assert.equal(isProtectedWorkspacePath(join(root, path), root), false, path);
  }
});

test("execution environment removes sensitive values unless explicitly allowlisted", () => {
  const sanitized = sanitizeExecutionEnvironment({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    NODE_ENV: "test",
    DEVSPACE_OAUTH_OWNER_TOKEN: "fake-owner-token",
    GITHUB_TOKEN: "fake-github-token",
    OPENAI_API_KEY: "fake-api-key",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    DATABASE_URL: "postgres://fake",
  });

  assert.deepEqual(sanitized, {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    NODE_ENV: "test",
  });
  assert.equal(
    sanitizeExecutionEnvironment(
      { PATH: "/usr/bin", OPENAI_API_KEY: "fake-api-key" },
      ["OPENAI_API_KEY"],
    ).OPENAI_API_KEY,
    "fake-api-key",
  );
  assert.equal(
    sanitizeExecutionEnvironment(
      { DEVSPACE_OAUTH_OWNER_TOKEN: "fake-owner-token" },
      ["DEVSPACE_OAUTH_OWNER_TOKEN"],
    ).DEVSPACE_OAUTH_OWNER_TOKEN,
    undefined,
  );
  assert.deepEqual(parseEnvironmentAllowlist(" OPENAI_API_KEY,GITHUB_TOKEN,OPENAI_API_KEY,bad-name "), [
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
  ]);
});

test("log sanitization redacts common credential forms without hiding normal context", () => {
  const redacted = redactSensitiveText(
    "Authorization: Bearer fake.token password=supersecret api_key:abc123 https://user:pass@example.com/path normal=visible",
  );
  assert.doesNotMatch(redacted, /fake\.token|supersecret|abc123|:pass@/);
  assert.match(redacted, /\[redacted\]/);
  assert.match(redacted, /password=\[redacted\]/i);
  assert.match(redacted, /normal=visible/);

  assert.deepEqual(
    sanitizeLogFields({
      event: "test",
      ownerToken: "fake-owner",
      nested: { message: "token=abc123", status: "ok" },
    }),
    {
      event: "test",
      ownerToken: "[redacted]",
      nested: { message: "token=[redacted]", status: "ok" },
    },
  );
});

test("workspace secret discovery finds project secrets but skips dependency trees", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-security-scan-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
  await writeFile(join(root, "node_modules", "fixture", ".env"), "fake=dependency\n");
  assert.equal(await findProtectedWorkspacePath(root), undefined);

  await mkdir(join(root, "config"), { recursive: true });
  const protectedPath = join(root, "config", ".env.local");
  await writeFile(protectedPath, "fake=project\n");
  assert.equal((await findProtectedWorkspacePath(root))?.endsWith("/config/.env.local"), true);
});
