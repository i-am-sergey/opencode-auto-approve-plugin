# OpenCode auto-approve plugin

This OpenCode V2 plugin reviews pending permission requests with a configured model. It replies `once` only when the reviewer approves the exact pending request. An abstention, error, or missing context leaves the permission for the user to decide. The plugin never saves an `always` approval.

The companion TUI plugin shows short toasts when review starts and when the reviewer approves or abstains. It can also report that a permission was resolved outside the plugin. That event does not identify the person who replied. Toasts contain no prompt or permission resource.

## Install

1. Install the test dependencies: `npm ci`.
2. Install the plugin dependencies: `npm ci --prefix plugins/auto-approve`.
3. Add the plugin to your OpenCode V2 `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugins/auto-approve",
      "options": {
        "enabled": true,
        "actions": ["read", "external_directory"],
        "model": { "providerID": "YOUR_PROVIDER", "id": "YOUR_MODEL" }
      }
    }
  ]
}
```

Use the full path to `plugins/auto-approve` when the configuration is outside this checkout. Select a reviewer model that is available in your OpenCode installation. The repository's own `opencode.jsonc` does not enable the plugin.

`actions` is an explicit permission-action allowlist. The plugin also accepts `"*"`, but that sends all eligible permission actions to the reviewer. Start with the actions that you need. Set `enabled` to `false` or remove the plugin entry to stop automatic review. Reopen the TUI if the companion plugin does not appear after installation.

## How review works

The plugin handles live `permission.asked` events. It uses a bounded copy of the latest direct user prompt for that session as context. The event does not contain the user prompt ID, so this association is best-effort. The reviewer receives that text and the exact permission action and resources. It does not receive a full conversation or tool output.

For an `external_directory` permission tied to a `read` tool call, the plugin requires a running read with matching source IDs. It checks that the directory boundary matches the read target. It checks the target again before replying. If this link is unavailable or changes, the request stays pending. The reviewer still makes the approval decision.

The plugin limits input size, concurrent reviews, and review time. It checks the permission again before it replies. It does not bypass OpenCode permission rules or hard-deny policies. It does not reject a request when the reviewer abstains.

## Diagnostics and privacy

Add `"diagnostics": true` to the plugin options to write a bounded, owner-only trace at `~/.local/share/opencode/auto-approve-trace.jsonl`. The trace uses opaque request tokens and controlled status labels. An abstention can include a short, redacted excerpt of the parsed reviewer justification. Redaction cannot guarantee that free text contains no sensitive data.

For a one-time investigation, you can also set `"captureReviewerInput": true` **with** `"diagnostics": true`. This saves the exact reviewer input to `~/.local/share/opencode/auto-approve-review-input.json`. The file is owner-only, limited to 32 KiB, and never overwritten. It can contain sensitive prompts and paths. Disable the option after the investigation and remove the private capture when you no longer need it. Do not commit either diagnostic file or a session export.

Diagnostics are off by default. The repository does not contain a live model credential or captured reviewer input.

## Development

Run `npm run typecheck` and `npm test` from the repository root. The tests cover policy, lifecycle, diagnostics, and TUI notifications. See [ARCHITECTURE.md](ARCHITECTURE.md) for historical design notes. For current plugin behavior, use this README and the source code.

The project uses the [OpenCode V2 plugin API](https://opencode.ai/v2/docs/build/plugins). The TUI integration uses the [CLI plugin API](https://opencode.ai/v2/docs/build/plugins/cli) and [plugin RPC](https://opencode.ai/v2/docs/build/plugins/rpc).

## License

MIT. See [LICENSE](LICENSE).
