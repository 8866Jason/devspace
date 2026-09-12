import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "devspace-empty-config-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: emptyConfigDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.equal(loadConfig(baseEnv).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "off" }).widgets, "off");
assert.equal(loadConfig(baseEnv).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "minimal" }).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "full" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "codex" }).toolMode, "codex");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "0" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "1" }).toolMode, "minimal");
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.equal(loadConfig(baseEnv).sshAdminPolicy, "timed-unlock");
assert.deepEqual(loadConfig(baseEnv).shellEnvAllowlist, []);
assert.deepEqual(loadConfig(baseEnv).agentEnvAllowlist, []);
assert.equal(loadConfig(baseEnv).dangerouslyAllowUnsandboxedPublicShell, false);
assert.equal(loadConfig(baseEnv).dangerouslyAllowShellInSecretWorkspaces, false);
assert.equal(loadConfig(baseEnv).devspaceSkillsDir, join(emptyConfigDir, "skills"));
assert.equal(loadConfig(baseEnv).devspaceAgentsDir, join(emptyConfigDir, "agents"));
assert.deepEqual(loadConfig(baseEnv).subagents, { enabled: false, providers: [] });
assert.equal(loadConfig(baseEnv).artifactsEnabled, false);
assert.equal(loadConfig(baseEnv).artifactMaxFileBytes, 100 * 1024 * 1024);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_ARTIFACTS: "1" }).artifactsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "123" }).artifactMaxFileBytes,
  123,
);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "1" }).skillsEnabled, true);
assert.deepEqual(loadConfig({ ...baseEnv, DEVSPACE_SUBAGENTS: "1" }).subagents, {
  enabled: true,
  providers: [],
});
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "invalid" }),
  /Invalid DEVSPACE_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "minimal" }),
  /Invalid DEVSPACE_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "write-only" }),
  /Invalid DEVSPACE_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "invalid" }),
  /Invalid DEVSPACE_TOOL_MODE: invalid/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
});

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "1" }).logging.trustProxy, true);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "trace" }),
  /Invalid DEVSPACE_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "color" }),
  /Invalid DEVSPACE_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["devspace"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_SCOPES: "devspace,admin" }).oauth.scopes,
  ["devspace", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: emptyConfigDir, DEVSPACE_ALLOWED_ROOTS: process.cwd() }),
  /DEVSPACE_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_OWNER_TOKEN: "too-short" }),
  /DEVSPACE_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_ARTIFACT_MAX_FILE_BYTES: "0" }),
  /Invalid DEVSPACE_ARTIFACT_MAX_FILE_BYTES: 0/,
);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/", DEVSPACE_SHELL_SANDBOX: "devspace-test" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/", DEVSPACE_SHELL_SANDBOX: "devspace-test" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "devspace-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://devspace.example.com",
    shellSandbox: "devspace-test",
    subagents: true,
    artifactsEnabled: true,
    artifactMaxFileBytes: 321,
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://devspace.example.com");
assert.equal(fileConfig.subagents.enabled, true);
assert.equal(fileConfig.subagents.providers.length, 7);
assert.equal(fileConfig.artifactsEnabled, true);
assert.equal(fileConfig.artifactMaxFileBytes, 321);
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "devspace.example.com",
]);

const customConfigDir = mkdtempSync(join(tmpdir(), "devspace-custom-config-test-"));
writeFileSync(
  join(customConfigDir, "config.json"),
  JSON.stringify({
    allowedRoots: [process.cwd()],
    workspaceAliases: { demo: process.cwd() },
    shellSandbox: "devspace-coding",
    shellEnvAllowlist: ["SAFE_SECRET_FOR_SHELL"],
    agentEnvAllowlist: ["SAFE_SECRET_FOR_AGENT"],
    dangerouslyAllowShellInSecretWorkspaces: true,
    sshAdminPolicy: "timed-unlock",
    sshHosts: [
      {
        name: "prod-web",
        aliases: ["production"],
        host: "example.com",
        user: "deploy",
        port: 2222,
        identityFile: "~/.ssh/id_ed25519_test_fixture",
        tier: "admin",
      },
    ],
  }),
);
const customConfig = loadConfig({
  DEVSPACE_CONFIG_DIR: customConfigDir,
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
});
assert.equal(customConfig.workspaceAliases.demo, process.cwd());
assert.equal(customConfig.shellSandbox, "devspace-coding");
assert.deepEqual(customConfig.shellEnvAllowlist, ["SAFE_SECRET_FOR_SHELL"]);
assert.deepEqual(customConfig.agentEnvAllowlist, ["SAFE_SECRET_FOR_AGENT"]);
assert.equal(customConfig.dangerouslyAllowShellInSecretWorkspaces, true);
assert.equal(customConfig.sshAdminPolicy, "timed-unlock");
assert.equal(customConfig.sshHosts[0]?.name, "prod-web");
assert.equal(customConfig.sshHosts[0]?.aliases?.[0], "production");
assert.equal(customConfig.sshHosts[0]?.host, "example.com");
assert.equal(customConfig.sshHosts[0]?.tier, "admin");
assert.match(customConfig.sshAdminUnlockPath, /ssh-admin-unlock\.json$/);
assert.equal(customConfig.dangerouslyAllowShellInCredentialRoots, false);
assert.equal(
  loadConfig({
    DEVSPACE_CONFIG_DIR: customConfigDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_DANGEROUSLY_ALLOW_SHELL_IN_CREDENTIAL_ROOTS: "1",
  }).dangerouslyAllowShellInCredentialRoots,
  true,
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_SHELL_SANDBOX: "bad sandbox name",
  }),
  /Invalid DEVSPACE_SHELL_SANDBOX/,
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
  }),
  /requires shellSandbox/,
);
assert.equal(
  loadConfig({
    ...baseEnv,
    DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
    DEVSPACE_DANGEROUSLY_ALLOW_UNSANDBOXED_PUBLIC_SHELL: "1",
  }).dangerouslyAllowUnsandboxedPublicShell,
  true,
);
assert.deepEqual(
  loadConfig({
    ...baseEnv,
    DEVSPACE_SHELL_ENV_ALLOWLIST: "OPENAI_API_KEY,GITHUB_TOKEN,OPENAI_API_KEY",
    DEVSPACE_AGENT_ENV_ALLOWLIST: "ANTHROPIC_API_KEY",
  }).shellEnvAllowlist,
  ["OPENAI_API_KEY", "GITHUB_TOKEN"],
);
assert.deepEqual(
  loadConfig({
    ...baseEnv,
    DEVSPACE_AGENT_ENV_ALLOWLIST: "ANTHROPIC_API_KEY",
  }).agentEnvAllowlist,
  ["ANTHROPIC_API_KEY"],
);
