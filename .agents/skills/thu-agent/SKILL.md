---
name: thu-agent
description: Use QingLing / THU-agent for Tsinghua campus queries, library and sports bookings, payments, dorm hygiene scores, campus network status, Tsinghua Cloud Drive file operations, reminders and scheduled bookings. Applies to campus-service requests through the user's local checkout or connected QingLing MCP; not general university research.
---

# THU Agent

Use the bundled bridge to discover and call the repository's current capabilities. It reads `createAllSkills()` and proxies task capabilities to QingLing's running Web scheduler. Treat `list` and `describe` as the source of truth; do not maintain a separate parameter catalog.

## Invoke the bridge

Resolve this skill directory from the loaded `SKILL.md`, then run its sibling script with Node. It works regardless of the caller's current directory.

```bash
node <skill-directory>/scripts/thu-agent.mjs list
node <skill-directory>/scripts/thu-agent.mjs describe get_schedule
node <skill-directory>/scripts/thu-agent.mjs call get_schedule --input '{}'
```

`list` returns every available capability with its description and `requiresConfirmation` flag. Use `describe <name>` before a call when the exact JSON input schema is not already known. `call` accepts `{}` when `--input` is omitted.

The process writes one JSON result to stdout. Exit code `0` means the command or campus capability succeeded, `1` means the capability returned an error or a write was blocked, and `2` means the command or input was invalid. Never infer campus data when `success` is false.

For relative dates, resolve the user's intended date in `Asia/Shanghai` and pass it explicitly. Campus date defaults and task times use the process's local timezone; ensure the Web scheduler runs in `Asia/Shanghai` for Tsinghua local times. Use returned calendar/week data rather than inventing a teaching week.

## Authentication and setup

Run against the user's local THU-agent checkout with Node.js 22+, pnpm 10, installed dependencies, and a git-ignored `.env`. Direct campus calls require `THU_USERNAME` and `THU_PASSWORD`. `THU_FINGERPRINT` is optional: QingLing generates and reuses a locally stored device identity. Do not regenerate it for each call. The bridge does not call an LLM and needs no `LLM_*` configuration; reading image results requires the calling agent's image-viewing capability.

For `AUTH_REQUIRED`, have the user complete first-time authentication in a private terminal with `pnpm exec tsx scripts/mcp-login.ts` from the repository root, or use QingLing's graphical login on the same device. A Web login does not populate the CLI's `.env` or share its cookies automatically.

`get_network_status` requires `CJY_USER`, `CJY_PASSWORD`, and `CJY_SOFT_ID` for character captcha recognition, plus access to the campus usereg service. The client resolves its login name from Info's `emailName`; keep `THU_USERNAME` as the Info account, not a guessed email prefix. Sports booking may also use `CJY_*` for slider captchas. For network/configuration details and `NETWORK_AUTH_REQUIRED`, read [references/runtime.md](references/runtime.md).

Never ask the user to paste credentials into chat, command arguments, logs, or committed files. Do not print or summarize secret environment values. If setup is incomplete, name only the missing variable and direct the user to the repository's `.env.example`.

## Read operations

Use the least sensitive capability that answers the request and return only the campus data needed by the user. Do not include grades, balances, bookings, network device identifiers or image data in commits or diagnostic logs. Image viewing may use private temporary files as described below.

When combining capabilities, prefer independent read calls and use their returned dates, identifiers, availability, and candidate lists rather than guessing.

`get_sports_resources` now requires a nonempty `resourceName` keyword. Query a specific sport/venue and serialize sports queries; avoid parallel scans of all venues. Treat returned warnings or partial results as incomplete information, not proof that everything is unavailable.

## Tsinghua Cloud Drive

Use `get_cloud_libraries`, `get_cloud_directory`, and `search_cloud_files` to resolve the exact library and path before any cloud-drive write. `show_cloud_file` returns an access card for a video, audio, or ordinary file; do not claim to open a file unless the returned result reports success.

Cloud-drive upload, folder creation, rename, copy/move, delete, and share-link creation are real writes. Resolve and show the exact source path, target library/folder, destination name, operation, and effect before requesting confirmation. Share links expose data to whoever receives them; deletion is destructive and may require web-side recovery. Never perform or retry these writes without fresh user approval for the exact parameters.

## Image results

`get_dorm_score` returns a hygiene-score chart in `data.imagesBase64`, not numeric grades. Decode it without pasting base64 into the conversation:

```bash
node <skill-directory>/scripts/thu-agent.mjs call get_dorm_score | node <skill-directory>/scripts/extract-images.mjs
```

Open the returned absolute image paths with the host's image-viewing tool, read the chart, and report only legible dates and scores. If the host cannot view images, explain that the chart was retrieved but cannot be read in this environment; never guess scores. The helper creates a private temporary directory; remove only those generated files when no longer needed.

## Reminders and scheduled bookings

The bridge exposes `create_reminder`, `schedule_sports_booking`, `list_my_tasks`, and `cancel_task`. They require a running QingLing Web service with its scheduler, a completed Web login, and matching `UI_TOKEN` configuration in the service and CLI. Read [references/runtime.md](references/runtime.md) before using these capabilities or handling `TASK_SERVICE_*` errors.

The service owns persistence, execution and notifications. Keep it running through the scheduled time; closing the CLI does not cancel a task. Results appear in the Web session `external_skill` and can also be queried with `list_my_tasks --input '{"includeFinished":true}'`. A returned `taskId` confirms registration, not that the reminder has fired or the booking succeeded.

For scheduled booking, obtain explicit approval of the execution time, target date/time, venue, field selection, fee and payment mode when creating the task. That approval authorizes the service to execute this specific booking later without another prompt. Never interpret a request to check availability as permission to schedule a booking. Use an explicit target `date` (otherwise it means the execution day). Bookings over ten minutes late are skipped by the scheduler. Cancellation stops pending tasks, not an already executing or completed booking.

## Connected MCP

If the host already has QingLing MCP connected, use its listed tools for supported campus queries, including cloud-drive libraries, directories, search, and file display. MCP additionally provides `thu_login` and `get_user_info`; these are not CLI capability names. MCP defaults to read tools and rejects write tools even when `THU_MCP_INCLUDE_WRITE_TOOLS=1`; cloud-drive writes and share-link creation are therefore unavailable through MCP. The CLI confirmation flag does not apply to MCP. Task capabilities need the Web bridge above. MCP currently returns hygiene images as JSON text too, so they still need image decoding. See [references/runtime.md](references/runtime.md) for source/package entrypoints.

## Write operations

Treat every capability whose `requiresConfirmation` is `true` as a real-world write, even when it only creates a pending order, payment link, or QR code.

Before each write:

1. Use the relevant read capability to resolve the exact target and current state when one is available.
2. Show the user the exact operation, arguments, date/time, target, amount or fee, payment mode, and effect.
3. Obtain explicit confirmation for those exact parameters in the current conversation.
4. Only then repeat the call with `--confirmed-by-user`:

```bash
node <skill-directory>/scripts/thu-agent.mjs call <name> --input '<json>' --confirmed-by-user
```

The flag records the calling agent's attestation of the user's approval; it does not independently verify the conversation. Confirmation applies to one call only, including registration of a scheduled task as described above. Changed arguments, a different target, or a retry require fresh confirmation. If there is no interactive confirmation channel, omit the flag and allow the bridge to fail closed. Never treat the flag as permission to confirm on the user's behalf, and never automatically retry a write after rejection, timeout, or ambiguous failure.

For candidate or ambiguity errors, present the returned choices and ask the user to select one. For payment results, explain that scanning or completing the returned payment flow is still the user's action; do not claim payment succeeded unless the capability explicitly reports that outcome.
