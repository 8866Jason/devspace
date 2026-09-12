# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
npx @waishnav/devspace ssh admin-status
npx @waishnav/devspace ssh unlock-admin --minutes 15
npx @waishnav/devspace ssh lock-admin
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |
| `DEVSPACE_SHELL_SANDBOX` | Existing Docker Sandbox microVM name. Public DevSpace endpoints require this by default. `bash` and Codex-mode `exec_command` run through `sbx exec`; the host SSH agent socket is never forwarded. |
| `DEVSPACE_SHELL_ENV_ALLOWLIST` | Comma-separated environment-variable names explicitly allowed into shell processes. Sensitive names are removed by default. `DEVSPACE_OAUTH_OWNER_TOKEN` and `SSH_AUTH_SOCK` are never forwarded. |
| `DEVSPACE_AGENT_ENV_ALLOWLIST` | Comma-separated sensitive provider environment-variable names explicitly allowed into local-agent processes. Empty by default. |
| `DEVSPACE_DANGEROUSLY_ALLOW_UNSANDBOXED_PUBLIC_SHELL` | Break-glass override that permits a public endpoint without `shellSandbox`. Keep off. |
| `DEVSPACE_DANGEROUSLY_ALLOW_SHELL_IN_SECRET_WORKSPACES` | Break-glass override that permits shell access in a workspace containing protected project secret files. Keep off. |
| `DEVSPACE_DANGEROUSLY_ALLOW_SHELL_IN_CREDENTIAL_ROOTS` | Owner-only escape hatch for broad workspaces containing DevSpace credential/state paths. Defaults to off. |

## Native Artifact Download

Native-file download is disabled by default. Enable it when ChatGPT needs to hand
an attached or generated file into an already-open workspace:

```bash
DEVSPACE_ARTIFACTS=1 npx @waishnav/devspace serve
```

This feature currently supports Linux. It is not registered on macOS, Windows,
or BSD because the secure publication path depends on traversable,
descriptor-anchored directory paths provided by Linux procfs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_ARTIFACTS` | `0` | Expose `download_artifact` for trusted native files. |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `104857600` | Maximum streamed size of one file (100 MiB). |

The same settings may be persisted in `~/.devspace/config.json` as
`artifactsEnabled` and `artifactMaxFileBytes`.

`download_artifact` accepts the native file object supplied by the MCP connector,
a `workspaceId` returned by `open_workspace`, and a relative workspace `path`.
DevSpace safely creates missing parent directories, refuses to overwrite an
existing destination, and returns only the normalized workspace-relative path.
It does not accept conflict modes, expected hashes, arbitrary URL strings, local
paths, embedded credentials, or extra object fields.

There is no artifact root, total quota, TTL, pinning, persistent database record,
or background artifact cleanup service. See [Native File Download](artifact-exchange.md)
for the supported connector shape and security boundaries.

## OAuth

DevSpace uses a single-user OAuth approval flow. Non-loopback OAuth redirect URIs must use HTTPS; loopback redirects may use HTTP for local clients. Dynamic client registration is capped and OAuth POST endpoints are rate-limited in memory to reduce brute-force and state-exhaustion risk.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `read`, `read_many`, `write`, `edit`, `move`, `relocate_workspace`, `bash`, and `ssh`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Experimental. Exposes `open_workspace`, `read`, `read_many`, `move`, `relocate_workspace`, `ssh`, `apply_patch`, `exec_command`, and `write_stdin`. Direct `write`, `edit`, and `bash` remain hidden. |

`DEVSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`DEVSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `DEVSPACE_TOOL_MODE` and always uses
its fixed short tool names regardless of `DEVSPACE_TOOL_NAMING`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions. When `DEVSPACE_SHELL_SANDBOX` is configured, both pipe and PTY process
sessions are launched through that sandbox. A non-loopback/public
`DEVSPACE_PUBLIC_BASE_URL` is rejected at startup unless a sandbox is configured
(or the explicit dangerous override is set). Shell child environments are
sanitized before launch.

`read_many` accepts up to 64 files per call. `move` performs no-overwrite
same-workspace file or directory renames and rejects `.git`, credential/state,
symlink, and out-of-workspace paths. `relocate_workspace` copies a complete
workspace across allowed roots or disks, verifies the copied tree and file
contents, and removes the source only when explicitly requested after
verification.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_SUBAGENTS` | Optional master override for the persisted Subagents configuration. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- project `.pi/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagents` skill when Subagents are enabled, unless `~/.devspace/skills/subagents/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from:

- `~/.devspace/agents/*.md`
- project `.devspace/agents/*.md`

Enable providers and set their defaults in `~/.devspace/config.json`:

```json
{
  "subagents": {
    "enabled": true,
    "providers": [
      {
        "id": "codex",
        "enabled": true,
        "model": "gpt-5.4",
        "effort": "high"
      },
      {
        "id": "claude",
        "enabled": true,
        "model": "sonnet"
      },
      {
        "id": "grok",
        "enabled": true,
        "model": "grok-4.5",
        "effort": "low"
      }
    ]
  }
}
```

Each entry controls one provider. Providers omitted from the array are disabled.
`model` and `effort` are optional defaults; an invocation override wins over a
profile value, which wins over the provider default. The legacy boolean
`"subagents": true` remains readable and enables every provider, but new
configuration should use the explicit object form.

`devspace agents targets` shows usable providers and profiles for the current
workspace. Add `--json` for a compact list of exact target names and their
selection metadata. Disabled, unavailable, and unconfigured providers are
omitted. Provider availability is runtime state and never rewrites the
configuration.

Grok Build is discovered from the `grok` executable. Authenticate it with
`grok login` or `XAI_API_KEY`; DevSpace does not read or store Grok credentials.
Grok supports `grok-build` by default and validates explicit model and effort
values against the ACP session metadata when available. Set `GROK_COMMAND` when
the executable is not on the normal PATH. If your Grok installation selects a
custom agent profile, set `GROK_AGENT_PROFILE` to that profile's path; DevSpace
passes it to `grok agent stdio` without writing to Grok's configuration.

`open_workspace` returns a compact catalog containing profile names,
descriptions, providers, and optional models/effort levels so the host model can choose an
agent without reading provider-specific launch details. Disabled or unavailable
providers and their profiles are omitted from this model-facing catalog. `devspace agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagents`
skill teaches the model to use only the minimal `devspace agents ls`,
`devspace agents targets`, `devspace agents run`, `devspace agents continue`,
and `devspace agents show` workflow.

For Codex, Claude Code, OpenCode, Pi, or another supported Coding Agent, use
the Skills CLI to install the same skill. DevSpace setup prints this command but
does not run it or write into agent skill directories:

```bash
npx skills add Waishnav/devspace --skill subagents --global
```

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Project `.pi/skills` is loaded automatically for backward compatibility. Other
legacy or organization-specific skill roots can be added through
`DEVSPACE_SKILL_PATHS` when needed.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx @waishnav/devspace serve
```

## Workspace aliases

Persist short workspace aliases in `~/.devspace/config.json`:

```json
{
  "workspaceAliases": {
    "demo": "~/Projects/example-site"
  }
}
```

`open_workspace` accepts either `@demo` or `demo` and resolves it before normal
allowed-root, checkout/worktree, and conversation-reuse handling.

## SSH hosts

SSH is opt-in and allowlisted. Configure only host metadata and local key paths;
never paste private-key contents, passwords, OAuth tokens, or other credentials
into `config.json`, source files, tests, Git commits, or pull requests.

```json
{
  "sshAdminPolicy": "timed-unlock",
  "sshHosts": [
    {
      "name": "prod-web",
      "aliases": ["production"],
      "host": "example.com",
      "user": "deploy",
      "port": 22,
      "identityFile": "~/.ssh/id_ed25519_example",
      "tier": "admin"
    }
  ]
}
```

The `ssh` MCP tool accepts only configured names or aliases and rejects arbitrary
hosts. It uses OpenSSH with batch authentication. Keep passphrases in the system
SSH agent or Keychain instead of DevSpace configuration. `sshAdminPolicy` defaults to `"timed-unlock"`. Admin-tier aliases require a
short local unlock performed interactively with `devspace ssh unlock-admin`.
Using `"direct"` is an explicit reduction in protection. The unlock record is
owner-local state and must never be committed.

While the server is running, changes to `sshHosts` in `config.json` are validated
and hot-reloaded. An invalid edit keeps the last known-good host list.

## Secret hygiene

`npm run check:secrets` scans tracked and unignored files without printing any
matched secret value. CI runs this check on every pull request. DevSpace also
ignores common local auth/token/private-key filenames. `auth.json`, SQLite state,
SSH private keys, temporary passwords, and admin-unlock state belong outside the
repository.

Model-facing workspace tools additionally reject common protected secret paths,
including `.env` variants, `wp-config.php`, `.npmrc`, `.netrc`, common private-key
files/directories, and local trigger-history state. Template files such as
`.env.example` remain readable. Broad `grep`, Codex `apply_patch`, aggregate
change review, and direct reads/writes all apply the same boundary.

Arbitrary shell commands cannot be made safe merely by hiding a file tool. By
default, DevSpace therefore refuses `bash`/`exec_command` when the workspace
contains protected project secrets. Local subagents are likewise refused in
such a workspace; use an isolated Git worktree without local secret files.
The shell break-glass setting exists for trusted workflows that knowingly need
access to a secret-bearing checkout.

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs. Log fields pass through credential redaction, and failed tool
calls do not persist raw stdout/stderr previews.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_ARTIFACTS="1" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
