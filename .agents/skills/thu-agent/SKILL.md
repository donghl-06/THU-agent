---
name: thu-agent
description: Access every THU campus capability in this repository for schedules, classrooms, grades, campus card, dorm electricity, library resources and bookings, and sports resources, booking, or payment. Use when an AI agent needs to query or perform an explicitly authorized Tsinghua campus action through the local THU-agent project; do not use for other institutions or without the user's own configured credentials.
---

# THU Agent

Use the bundled bridge to discover and call the repository's current atomic capabilities. The bridge reads the same `createAllSkills()` assembly used by the built-in agent, so treat its output as the source of truth instead of maintaining a separate capability list.

## Invoke the bridge

Resolve this skill directory from the loaded `SKILL.md`, then run its sibling script with Node. It works regardless of the caller's current directory.

```bash
node <skill-directory>/scripts/thu-agent.mjs list
node <skill-directory>/scripts/thu-agent.mjs describe get_schedule
node <skill-directory>/scripts/thu-agent.mjs call get_schedule --input '{"date":"2026-08-31"}'
```

`list` returns every available capability with its description and `requiresConfirmation` flag. Use `describe <name>` before a call when the exact JSON input schema is not already known. `call` accepts `{}` when `--input` is omitted.

The process writes one JSON result to stdout. Exit code `0` means the command or campus capability succeeded, `1` means the capability returned an error or a write was blocked, and `2` means the command or input was invalid. Never infer campus data when `success` is false.

## Authentication and setup

Run against the user's local THU-agent checkout with Node.js 22+, pnpm 10, installed dependencies, and a git-ignored `.env`. Campus calls require `THU_USERNAME`, `THU_PASSWORD`, and `THU_FINGERPRINT`; sports captcha solving additionally uses `CJY_*` only when configured. The external Skill does not need any `LLM_*` variables.

Never ask the user to paste credentials into chat, command arguments, logs, or committed files. Do not print or summarize secret environment values. If setup is incomplete, name only the missing variable and direct the user to the repository's `.env.example`.

## Read operations

Use the least sensitive capability that answers the request and return only the campus data needed by the user. These calls may expose grades, balances, bookings, and other private records; do not persist their results or include them in commits and logs.

When combining capabilities, prefer independent read calls and use their returned dates, identifiers, availability, and candidate lists rather than guessing.

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

Confirmation applies to one call only. Changed arguments, a different target, or a retry require fresh confirmation. If there is no interactive confirmation channel, omit the flag and allow the bridge to fail closed. Never treat the flag as permission to confirm on the user's behalf, and never automatically retry a write after rejection, timeout, or ambiguous failure.

For candidate or ambiguity errors, present the returned choices and ask the user to select one. For payment results, explain that scanning or completing the returned payment flow is still the user's action; do not claim payment succeeded unless the capability explicitly reports that outcome.
