# OpenCode Kiro Auth Plugin

[![npm version](https://img.shields.io/npm/v/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)
[![npm downloads](https://img.shields.io/npm/dm/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)
[![license](https://img.shields.io/npm/l/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)

OpenCode plugin for AWS Kiro (CodeWhisperer) providing access to Claude, GPT and
open-weight models with substantial trial quotas.

> **OpenCode v2 only.** This plugin uses the official `@opencode/plugin` API. It does
> not run on OpenCode v1 and it does not open any local port or proxy.

## Features

- **Zero-config models**: every model and its `-thinking` variants are registered by the
  plugin. No model list is needed in `opencode.jsonc`.
- **Native thinking**: Kiro reasoning is streamed into OpenCode's thinking block, and
  thinking budgets are mapped to Kiro effort levels (`low` to `max`).
- **Several auth methods**: AWS Builder ID, IAM Identity Center (Start URL and region),
  IAM Identity Center with a Profile ARN, and import from `kiro-cli`.
- **Safe token refresh**: Kiro refresh tokens rotate on use. A cross-process lock makes
  sure several OpenCode windows never refresh the same token at once (which used to end
  in `invalid_grant` and an account marked as unhealthy).
- **Startup usage toast**: the TUI part shows your credit usage when OpenCode starts,
  for example `Kiro usage (you@example.com): 327/2000 (16%)`.
- **Account rotation**: `lowest-usage`, `round-robin` or `sticky`.
- **Gradual context truncation** and **automatic retries** with backoff for rate limits.
- **Web search**: optional `kiro_web_search` tool (needs an account with a Profile ARN).

## How it works

```
OpenCode v2
  ├─ provider.transform   registers the "kiro" provider and all models
  ├─ aisdk hooks          give @ai-sdk/openai-compatible a custom fetch
  │                        └─ RequestHandler → Kiro (CodeWhisperer) API
  ├─ integration.transform adds the Kiro entry to /connect
  ├─ tool.transform       adds kiro_web_search
  └─ rpc (server → TUI)   usage and notices shown as toasts
```

Real tokens stay in `~/.config/opencode/kiro.db`. OpenCode's own credential store only
keeps a placeholder (`kiro-managed`) plus the account id and email.

## Installation

Register the plugin in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": [
    // From npm:
    "@zhafron/opencode-kiro-auth"
    // Or from a local checkout (must be a directory):
    // { "package": "/path/to/opencode-kiro-auth" }
  ]
}
```

That is all. Do not add a `provider.kiro` block with a `baseURL`. If you have one from
an older version that pointed to `http://127.0.0.1:40129`, remove it.

For a local checkout, build before first use and after every code change:

```bash
bun install
bun run build
```

Then restart OpenCode (see [Restarting OpenCode](#restarting-opencode)).

## Authenticating

### From OpenCode

Run `/connect` (or `opencode auth login kiro`) and pick one of:

| Method id  | What it does                                                          |
| ---------- | --------------------------------------------------------------------- |
| `idc`      | AWS Builder ID or IAM Identity Center. Blank Start URL means Builder ID. |
| `profile`  | IAM Identity Center with a Profile ARN (`arn:aws:codewhisperer:...` or `arn:aws:qdeveloper:...`). |
| `kiro-cli` | Runs `kiro-cli login` and imports the session.                        |

### From kiro-cli

```bash
kiro-cli login
```

With `auto_sync_kiro_cli` enabled (default), the plugin imports the active kiro-cli
session on startup and when a token is rejected.

Check the result with:

```bash
opencode auth list
opencode models | grep kiro
```

## Configuration

The plugin reads, in this order (later wins):

1. `~/.config/opencode/kiro.json` (user). Created with defaults on first run.
2. `<project>/.opencode/kiro.json` (project).

Example:

```json
{
  "idc_start_url": "https://your-company.awsapps.com/start",
  "idc_region": "us-east-1",
  "auto_sync_kiro_cli": true,
  "account_selection_strategy": "lowest-usage",
  "token_expiry_buffer_ms": 120000
}
```

| Key                          | Default        | Description                                                                 |
| ---------------------------- | -------------- | --------------------------------------------------------------------------- |
| `idc_start_url`              | none           | Default IAM Identity Center Start URL. Blank means Builder ID.              |
| `idc_region`                 | none           | SSO region (`sso_region`) used for the OIDC flow.                           |
| `idc_profile_arn`            | none           | Default Profile ARN for Identity Center accounts.                           |
| `default_region`             | `us-east-1`    | Region of the Kiro API endpoint.                                            |
| `account_selection_strategy` | `lowest-usage` | `sticky`, `round-robin` or `lowest-usage`.                                  |
| `auto_sync_kiro_cli`         | `true`         | Import and refresh sessions from the local kiro-cli database.               |
| `usage_tracking_enabled`     | `true`         | Query live credit usage (used by the startup toast).                        |
| `token_expiry_buffer_ms`     | `300000`       | Refresh the access token this long before it expires (30000 to 300000).     |
| `rate_limit_retry_delay_ms`  | `5000`         | Base delay between rate limit retries.                                      |
| `rate_limit_max_retries`     | `3`            | Max rate limit retries (0 to 10).                                           |
| `max_request_iterations`     | `30`           | Max retry/truncation iterations per request.                                |
| `request_timeout_ms`         | `120000`       | Request timeout (30000 to 600000).                                          |
| `usage_sync_max_retries`     | `3`            | Retries when syncing usage.                                                 |
| `effort`                     | none           | Fixed effort for thinking models: `low`, `medium`, `high`, `xhigh`, `max`.  |
| `auto_effort_mapping`        | `true`         | Map OpenCode thinking budgets to effort levels.                             |
| `web_search_enabled`         | `true`         | Register `kiro_web_search` when an account has a Profile ARN.               |
| `enable_log_api_request`     | `false`        | Log request payloads to the plugin log (verbose).                           |

Changes to `kiro.json` are read when the plugin loads, so restart OpenCode after
editing it.

### Files used

| Path                                       | Purpose                    |
| ------------------------------------------ | -------------------------- |
| `~/.config/opencode/kiro.db`               | Accounts and tokens        |
| `~/.config/opencode/kiro.json`             | Plugin configuration       |
| `~/.config/opencode/kiro-logs/plugin.log`  | Plugin log                 |

## Restarting OpenCode

OpenCode v2 runs a background service (`opencode serve --service`) that keeps plugins
loaded. Opening another terminal does not reload them. If your changes are not picked up
(new build, edited `kiro.json`, Kiro missing in `/connect`, old models), restart it.

1. Restart the background service:

   ```bash
   opencode service restart
   ```

   Check it with `opencode service status`. If it hangs, use `opencode service stop`
   followed by `opencode service start`.

2. Close and reopen every open `opencode` TUI. Open TUIs keep the old TUI part and the
   old connection to the server.

3. Verify:

   ```bash
   opencode auth list          # Kiro (AWS CodeWhisperer) should be listed
   opencode models | grep kiro # models should be listed
   ```

To test a build without touching the background service, run a private server:

```bash
opencode models --standalone | grep kiro
opencode --standalone
```

## Troubleshooting

- **Kiro does not appear in `/connect`**: run `bun run build`, then restart the service
  as above. Make sure `plugins` (not `plugin`) lists the package, and that a local path
  points to a directory.
- **No usage toast at startup**: the toast comes from the TUI part (`./tui`). Restart the
  TUI after rebuilding. Details are in `~/.config/opencode/kiro-logs/plugin.log`.
- **`invalid_grant` or `invalid_client`**: the stored session is no longer valid. Run
  `kiro-cli login` (or reconnect from `/connect`) and the plugin will import it.
- **"All Kiro accounts are permanently unhealthy"**: same fix as above.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

`dist/` is generated and not committed. The build keeps `@opencode/*`, `@ai-sdk/*` and
`effect` external so the plugin uses the host's copies.

## License

MIT
