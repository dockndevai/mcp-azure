# mcp-azure

[![CI](https://github.com/dockndevai/mcp-azure/actions/workflows/ci.yml/badge.svg)](https://github.com/dockndevai/mcp-azure/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@dockndevai/mcp-azure)](https://www.npmjs.com/package/@dockndevai/mcp-azure)

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Azure** (via the Azure Resource Manager API — the programmatic layer behind the Azure Portal). It lets an MCP-capable client (Claude Desktop, Claude Code, Cursor, Codex, …) inventory and operate Azure resources — with a governance layer that keeps an AI agent inside safe boundaries.

## What this offers

- **Inventory** — list subscriptions, locations, resource groups, and resources; get any resource by ARM id.
- **Operations** — create resource groups (in approved regions), merge tags onto any resource, and control VM power state (start / stop / restart / deallocate).
- **Lifecycle** — delete resource groups and individual resources, guarded.
- **Governance built in** — access modes, subscription/resource-group allowlists, protected resource groups, a location allowlist for new groups, delete gating, typed confirmation for high-impact deletes, dry-run, and JSON audit logging.

## Governance & security model

| Concern | Flag | Default | Effect |
| --- | --- | --- | --- |
| What can the server do? | `AZURE_MODE` | `read-only` | `read-only` → inventory; `read-write` → create RG, tag, VM power; `admin` → deletes. Tools above the mode are **never registered**. |
| Which subscriptions? | `AZURE_SUBSCRIPTION_ALLOWLIST` | *(all)* | Operations on other subscriptions are refused. |
| Which resource groups? | `AZURE_RESOURCE_GROUP_ALLOWLIST` | *(all)* | Operations outside the list are refused. |
| Read-only-forever groups | `AZURE_PROTECTED_RESOURCE_GROUPS` | *(none)* | Readable, never mutable. |
| Approved regions | `AZURE_LOCATION_ALLOWLIST` | *(any)* | New resource groups may only be created here. |
| Can it delete? | `AZURE_ALLOW_DELETE` | `false` | Deletes need this **and** admin mode. |
| Typed confirmation | `AZURE_REQUIRE_CONFIRMATION` | `true` | Deletes require `confirm` to equal the target name — not just a boolean. |
| Preview | `AZURE_DRY_RUN` | `false` | Write/admin tools validate + log intent, then return. |
| Audit trail | `AZURE_AUDIT_LOG` | `true` | JSON line to stderr per guarded operation. |

## Tools

**Read** (`read-only`+): `list_subscriptions`, `list_locations`, `list_resource_groups`, `list_resources`, `get_resource`

**Write** (`read-write`+): `create_resource_group`, `tag_resource`, `control_vm`

**Admin** (`admin`): `delete_resource_group`, `delete_resource` (both need `AZURE_ALLOW_DELETE` + typed `confirm`)

## Quickstart — add to your agent

Published on npm as [`@dockndevai/mcp-azure`](https://www.npmjs.com/package/@dockndevai/mcp-azure). Runs via `npx` with an Entra ID service principal. See [docs/CLIENTS.md](docs/CLIENTS.md) for every client and [`.env.example`](.env.example) for all variables.

**Claude Code**

```bash
claude mcp add azure -e AZURE_TENANT_ID="…" -e AZURE_CLIENT_ID="…" -e AZURE_CLIENT_SECRET="…" -e AZURE_SUBSCRIPTION_ID="…" -e AZURE_MODE="read-only" -- npx -y @dockndevai/mcp-azure
```

**Claude Desktop · Cursor · Windsurf**

```json
{
  "mcpServers": {
    "azure": {
      "command": "npx",
      "args": ["-y", "@dockndevai/mcp-azure"],
      "env": {
        "AZURE_TENANT_ID": "…",
        "AZURE_CLIENT_ID": "…",
        "AZURE_CLIENT_SECRET": "…",
        "AZURE_SUBSCRIPTION_ID": "…",
        "AZURE_MODE": "read-only"
      }
    }
  }
}
```

## Example prompts

- *"List all resource groups in my subscription and which region each is in"*
- *"Show every resource in the rg-web group"*
- *"Tag the app-plan resource with env=prod and owner=team-a"* (needs read-write)
- *"Stop the build-agent VM in rg-ci"* (needs read-write)

## Run from source (development)

```bash
npm install
npm run build
node dist/index.js   # with the environment variables set
```

## Develop

```bash
npm run dev
npm test          # governance policy: modes, scoping, location allowlist, delete + confirmation
npm run typecheck
```

## Publishing

Ships a [`server.json`](server.json) for the official MCP registry and an [`mcpName`](package.json) for npm ownership validation. See **[PUBLISHING.md](PUBLISHING.md)**.

## License

MIT
