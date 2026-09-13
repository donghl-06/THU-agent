# Runtime-specific requirements

## Web task bridge

The one-shot CLI forwards task calls to the existing Web scheduler via `POST /api/skills/tasks`. It does not start a background process, create a separate task database, or run its own notification loop.

The user configures the same nonempty `UI_TOKEN` in the ignored `.env` used by both the CLI and Web service, starts `pnpm web`, and signs into QingLing in the browser. A normal Web chat uses its configured LLM; direct task calls do not. The service stores tasks in its existing `data/tasks.json`, uses the existing notification hub, and writes notifications to session `external_skill`. Keep the service running for scheduled work. To inspect completed or cancelled tasks and `lastMessage`, use:

```bash
node <skill-directory>/scripts/thu-agent.mjs call list_my_tasks --input '{"includeFinished":true}'
```

`THU_SKILL_SERVER_URL` optionally selects a different local service port (default `http://127.0.0.1:${PORT:-3457}`). Only literal loopback HTTP origins (`127.0.0.1` or `[::1]`) are accepted, without a path, embedded credentials, query or fragment. The client reads `UI_TOKEN` privately and sends it as a Bearer header, bypassing system proxies and refusing redirects. Do not put the token in arguments or show it to the agent/user. The server rejects browser-origin requests, nonlocal clients, missing/mismatched tokens, and calls before Web login. This task-only endpoint cannot call arbitrary campus tools.

| Error | Action |
| --- | --- |
| `TASK_SERVICE_AUTH_REQUIRED` | User checks matching `UI_TOKEN` configuration; restart the Web service after changing it. |
| `TASK_SERVICE_CONFIG` | Check the local service URL and port; do not send the token to a remote host. |
| `TASK_SERVICE_UNAVAILABLE` | Check that the service is running. If a write might have reached it, query tasks before considering any retry. |
| `AUTH_REQUIRED` | Complete QingLing Web login. CLI credentials alone do not authenticate the task service. |
| `SCHEDULER_UNAVAILABLE` | The connected service lacks the scheduler; use the current QingLing Web entrypoint. |
| `CONFIRMATION_REQUIRED` | Obtain approval for the concrete operation before supplying `--confirmed-by-user`. |

`list_my_tasks` returns the local user's tasks, including those created in Web chats. Use returned IDs to select a task; do not infer ownership from a title. Notifications in the Web UI may already have been consumed, so inspect completed task results rather than draining `/api/notifications` for routine checks. The scheduler polls every 30 seconds, uses the service's local timezone, and skips bookings over ten minutes late. OS sleep or service shutdown prevents on-time execution; do not promise exact-time delivery. A task that is already executing may finish even after a cancellation request.

## Campus network

`get_network_status` uses an independent cookie session for `https://usereg.tsinghua.edu.cn`. It needs a working route to the campus service and configured `CJY_*` character captcha recognition (an external paid provider). Missing captcha configuration returns `NETWORK_AUTH_REQUIRED`. An existing, user-configured `USEREG_BASE_URL` can override the service base for a suitable network route; do not guess or automatically change it. The Info client resolves the campus-network username from `emailName` using the user's ordinary Info account.

## Authentication and MCP

`THU_FINGERPRINT` is an optional explicit override. Otherwise QingLing stores its device identity under the local QingLing state directory (`QINGLING_DEVICE_FILE` can override the path). Reuse the same identity for first-time authentication and subsequent calls.

For a source checkout, the user can run `pnpm exec tsx scripts/mcp-login.ts` privately to complete first-time 2FA. For the standalone Windows MCP package, use `登录清华账号.cmd`. This establishes device trust; it does not make Web cookies or runtime credentials available to the one-shot CLI. Keep `.env` configured for direct CLI calls.

Source MCP entrypoint: `pnpm --silent mcp` from the repository root. The Windows `清灵-MCP` package bundles `runtime/node.exe` and `mcp-server.cjs`; it does not require a system Node/pnpm installation. The skill's Node bridge itself remains checkout-based and must retain the repository layout. Copying only this skill folder elsewhere does not install the runtime. MCP has no task scheduler and no accepted write-confirmation flag.
