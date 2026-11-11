# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-11

### Security
- Strict mode (`*_REQUIRE_HUMAN_APPROVAL`) now refuses an action whose target's version cannot be read (it used to proceed unpinned), and the approval prompt no longer calls reversible changes (moves, config changes) irreversible.
- **Approval prompts are fully reviewable.** Arguments are shown in full up to 16 000 characters (previously cut at 1500, so a padded prefix could hide the tail of a long statement); a longer action is refused instead of approved blind. Secret redaction in prompts matches whole words (`bypass`/`tokenizer` are no longer shown as `[redacted]`).
- laya-guard now receives the secret-redacted arguments (`canonicalArgs`) instead of `JSON.stringify(args)`, so credentials in tool arguments no longer reach the guard prompt, the guard daemon, or its log.
- **The ARM bearer token can no longer be sent to another host.** `AzureClient.request()` sent the token to
  any path starting with `http`, so `get_resource` / `delete_resource` / `tag_resource` with a model-supplied
  `resourceId` of `https://attacker.example/...` sent the Azure token there. Every request URL is now built in
  one place and must be a relative ARM path made of plain segments or an `https` URL on exactly
  `management.azure.com` (no other host, port, scheme or userinfo); anything else is refused BEFORE a token is
  acquired. Tools additionally require `resourceId` to be an ARM id (`/subscriptions/{id}/...`), and every
  subscription / resource group / VM / resource name interpolated into a path must be a plain segment (no
  `/`, `..`, `?`, `#`, `%`, `\` or whitespace), which also closes `..` traversal out of the checked scope.
- **Scope checks use the subscription and resource group parsed from the resource id.** `get_resource`,
  `tag_resource` and `delete_resource` evaluated the subscription / resource-group allowlists and the
  protected-resource-group check on the optional model-supplied `resourceGroup` argument (`get_resource`
  passed none; `delete_resource` checked no subscription), so omitting it or naming a different group skipped
  the checks. They now check what is parsed from the id, and a supplied `subscription` / `resourceGroup` that
  disagrees with the id is refused. With `AZURE_RESOURCE_GROUP_ALLOWLIST` set, a subscription-scoped id (no
  resource group) is refused.
- **Subscription, resource-group and protected-group comparisons are case-insensitive** (ARM names are), so
  `RG-PROD` no longer slips past a protected `rg-prod`.
- `delete_resource` refuses a bare subscription or resource-group id (use `delete_resource_group`, which has the
  typed prompt and version pinning).
- **`list_resources` no longer lists outside `AZURE_RESOURCE_GROUP_ALLOWLIST`.** Without a `resourceGroup`
  argument it returned the whole subscription (names, types, locations of resources in groups the allowlist
  excludes). Each result is now filtered by the resource group parsed from its id (case-insensitive); with an
  allowlist set, an item whose group cannot be determined (missing/malformed id, subscription-scoped resource)
  is dropped. Resources in `AZURE_PROTECTED_RESOURCE_GROUPS` remain readable and carry `protected: true`
  (every item now has a `protected` field, as in `list_resource_groups`). `list_subscriptions`,
  `list_locations` and `list_resource_groups` were already scoped; tests now pin that.
- **`list_subscriptions`, `list_resource_groups` and `list_resources` now follow ARM paging.** They made a
  single request and ignored `nextLink`, so a large subscription returned only its first page (about 1000
  entries) and the allowlist filtering above then silently under-reported. They now use the existing
  `listAll` helper, which only follows `nextLink`s on `management.azure.com` and stops after 50 pages. When
  the cap is hit the result is `{ "truncated": true, "note": …, "items": […] }` instead of a plain array, so a
  partial listing is explicit; a complete listing is unchanged (a plain array). `list_locations` is not paged.
- **`delete_resource` ties `resourceName` to the resource id.** The typed `confirm` was compared against the
  model-supplied `resourceName`, which was not tied to the id, so a model could pair a destructive id with a
  harmless-looking name and matching `confirm`, and the human saw that name. `resourceName` must now equal the
  final segment of `resourceId` (case-insensitive) or the call is refused; the `confirm` check and the approval
  prompt use the name taken from the id.
- **Approval no longer fails open on timeout.** The human-approval prompt used the MCP SDK's default
  60 s request timeout, and a timeout fell through to "approved" (the `AZURE_ALLOW_DELETE` gate had
  already passed). A prompt nobody answered therefore auto-approved a destructive operation. A timeout
  is now a refusal, and the wait defaults to 5 minutes.

### Added
- **Approvals are bound to the exact action.** The prompt shows the tool, the full (secret-redacted)
  arguments and a fingerprint; every approval and refusal is written to the audit log as
  `"audit":"approval"` with the fingerprint, resource version and `approvedBy` (`human` / `flag-only`).
- **Approvals are bound to the target's version.** `delete_resource_group`, `delete_resource` and
  `control_vm` (powerOff / restart / deallocate) read a version token before the prompt and again after
  the human answers, and refuse if it changed: resource group = id, location, tags and the id +
  createdTime of its resources; resource = id + ARM `etag` (or a hash of the GET body without
  `provisioningState` when the type returns no etag); VM = id, `vmId`, size and OS-disk id.
- `AZURE_REQUIRE_HUMAN_APPROVAL=true` — refuse destructive ops when the client cannot elicit.
- `delete_resource_group` asks the human to type the group name. This is in addition to, not instead
  of, the existing model-supplied `confirm` argument (`AZURE_REQUIRE_CONFIRMATION`), which is unchanged
  and still checked first.

Tracking issue: https://github.com/dockndevai/mcp-core/issues/1

## [0.3.5] - 2026-11-09

### Changed
- Routine dependency/security maintenance. `npm audit --audit-level=high` reported 0
  vulnerabilities before and after this pass.
- Took the safe in-range minor bump: `vitest` 5.0.5 → 5.1.0 (dev dependency). No direct
  dependency crossed a major version boundary; `npm run typecheck`, `npm run build`, and
  `npm test` all pass; final `npm audit` is clean.

### Note
- v0.3.1–v0.3.4 are committed to `main` from prior maintenance passes but were never
  tagged/released — the npm registry's `latest` dist-tag is still 0.3.0. Tagging/publishing
  is blocked for this automated session (pushing a `v*` tag is denied by the session's
  permission policy as "create public surface"); a human needs to push the release tag(s)
  to actually publish.

## [0.3.4] - 2026-11-02

### Changed
- Routine weekly dependency maintenance: `npm audit --audit-level=high` reported 0 advisories (no high/critical findings). Took the safe in-range patch bump for `@types/node` (26.6.5 → 26.6.6); no direct dependency crossed a major version boundary. `npm audit` reports 0 vulnerabilities after the bump.

## [0.3.3] - 2026-10-26

### Changed
- Routine weekly dependency maintenance: `npm audit --audit-level=high` flagged a high-severity `body-parser` DoS advisory (GHSA-27r3-jxmh-p828) and a moderate `fast-uri` advisory chain; resolved both via `npm audit fix` (transitive bumps `body-parser` 2.3.0 → 2.4.0, `fast-uri` 3.1.8 → 3.1.9, `qs` 6.16.0 → 6.16.1), no direct dependency crossed a major version. Took the in-range patch bump for `@modelcontextprotocol/sdk` (1.32.1 → 1.32.2). `npm audit` reports 0 vulnerabilities after the bumps.

## [0.3.2] - 2026-10-19

### Changed
- Routine dependency/security maintenance. `npm audit --audit-level=high` reported 0
  vulnerabilities both before and after this pass (no high/critical advisories to fix).
- Took safe in-range patch bumps: `zod` ^4.5.4 → ^4.6.7, `vitest` ^5.0.0 → ^5.0.5.
- No direct dependency crossed a major version boundary; `npm run typecheck`, `npm run build`,
  and `npm test` all pass; final `npm audit` is clean.

## [0.3.1] - 2026-10-12

### Security
- Bump `@modelcontextprotocol/sdk` to 1.32.1 (within `^1.30.0`), fixing a high-severity advisory where the OAuth client could send credentials to an authorization server chosen by the MCP server, plus transitive fixes for `proxy-addr` (critical, IP-spoofing trust-subnet bug) and `source-map-js` (high, event-loop DoS). `npm audit` now reports 0 vulnerabilities.

### Changed
- Routine dependency maintenance: update `@types/node`, `tsx`, `vitest`, and `zod` to their latest in-range patch/minor versions.

## [0.3.0] - 2026-09-29

### Added
- **Optional AI risk guard (laya-guard).** Mutating tools can consult a local [laya-guard](https://github.com/dockndevai/laya-guard) daemon that classifies each operation allow / confirm / block before it runs. Runs after the deterministic policy gates and can only *tighten*, never grant; fails closed. Off by default (`AZURE_GUARD_MODE=monitor|enforce`).

## [0.2.2] - 2026-09-12

### Changed
- Bring dependencies and CI to current majors: `zod` ^4, TypeScript ^7, `@types/node` ^26, `tsx` ^4.23, and GitHub Actions (checkout v7, setup-node v7, action-gh-release v3, gitleaks v3, codeql-action v4). Clears the open Dependabot updates; `npm audit` reports 0 vulnerabilities.

## [0.2.1] - 2026-09-10

### Added
- Extend interactive confirmation (MCP elicitation) to `control_vm` for disruptive power actions (`powerOff` / `deallocate` / `restart`); a plain `start` is not gated.

## [0.2.0] - 2026-09-10

### Added
- **Human-in-the-loop confirmation for destructive actions**, via MCP [elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation). When the connected client supports elicitation, `delete_resource_group` and `delete_resource` now pause and ask the **human** to approve the exact action before it runs — a model can echo a confirmation string, but it cannot approve a prompt shown to the user. Clients that don't advertise elicitation fall back to the existing `*_ALLOW_*` flag gate, so enabling this is never *more* permissive than before.

## [0.1.3] - 2026-09-09

### Changed
- Require **Node 22** (previously Node 20); the updated dependency tree needs Node ≥ 22.19. CI and release workflows, the Dockerfile base image, and `engines` were updated.
- Bump the test runner `vitest` to ^5.0.0.

### Security
- Refresh the dependency tree to clear the moderate `hono` and `qs` advisories (transitive via the MCP SDK's HTTP transport, unused by this stdio server) and the `vitest` advisory; `npm audit` now reports **0 vulnerabilities**.

## [0.1.2] - 2026-08-30

### Changed
- Bump `@modelcontextprotocol/sdk` to ^1.30.0 to clear known dependency advisories flagged by supply-chain scanners.

## [0.1.1] - 2026-08-28

### Added
- MCP **tool annotations** on every tool (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`), derived from each tool's access
  capability. Hosts can now reason about a tool's safety from structured
  metadata instead of parsing the description — read tools are advertised as
  read-only and non-destructive, admin/destructive tools as mutating.
- A test that keeps the annotations consistent with each tool's capability.

## [0.1.0]

### Added
- Initial release.
