import assert from "node:assert/strict";
import { localAgentDaemonEnvironment } from "./local-agent-client.js";

const base = localAgentDaemonEnvironment(
  "/tmp/devspace-agent-state",
  {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    DEVSPACE_CONFIG_DIR: "/tmp/devspace-config",
    DEVSPACE_ALLOWED_ROOTS: "/tmp/project",
    DEVSPACE_OAUTH_OWNER_TOKEN: "fake-real-owner-token",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    ZZZ_DEVSPACE_SECURITY_API_KEY: "fake-provider-key",
  },
);
assert.equal(base.PATH, "/usr/bin");
assert.equal(base.DEVSPACE_CONFIG_DIR, "/tmp/devspace-config");
assert.equal(base.DEVSPACE_ALLOWED_ROOTS, "/tmp/project");
assert.equal(base.DEVSPACE_STATE_DIR, "/tmp/devspace-agent-state");
assert.equal(base.DEVSPACE_PUBLIC_BASE_URL, "http://127.0.0.1:7676");
assert.equal(base.DEVSPACE_OAUTH_OWNER_TOKEN, "local-agent-daemon-owner-not-used");
assert.equal(base.SSH_AUTH_SOCK, undefined);
assert.equal(base.ZZZ_DEVSPACE_SECURITY_API_KEY, undefined);

const allowlisted = localAgentDaemonEnvironment(
  "/tmp/devspace-agent-state",
  {
    PATH: "/usr/bin",
    ZZZ_DEVSPACE_SECURITY_API_KEY: "fake-provider-key",
  },
  ["ZZZ_DEVSPACE_SECURITY_API_KEY"],
);
assert.equal(allowlisted.ZZZ_DEVSPACE_SECURITY_API_KEY, "fake-provider-key");
