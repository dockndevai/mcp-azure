# Security & governance

`mcp-azure` exposes Azure Resource Manager to an AI agent. Treat it like any other
privileged automation and grant it the least access it needs.

## Governance controls

- **Start read-only.** Leave `AZURE_MODE=read-only` until you need changes. Tools
  above the current mode are never registered.
- **Scope with RBAC first.** The service principal's Azure RBAC role is the primary
  control — assign Reader to begin. `AZURE_SUBSCRIPTION_ALLOWLIST` and
  `AZURE_RESOURCE_GROUP_ALLOWLIST` further constrain reach, and
  `AZURE_PROTECTED_RESOURCE_GROUPS` marks groups that can be read but never mutated.
- **Constrain regions.** `AZURE_LOCATION_ALLOWLIST` limits where new resource groups
  may be created — a common governance requirement.
- **Gate deletion explicitly.** `delete_resource_group` / `delete_resource` need
  `admin` mode **and** `AZURE_ALLOW_DELETE=true`.
- **Typed confirmation for high-impact ops.** With `AZURE_REQUIRE_CONFIRMATION=true`
  (default), deletes require a `confirm` argument equal to the target name — a
  boolean is not enough. This stops an agent from deleting the wrong group on a
  loose instruction.
- **Preview with dry-run.** `AZURE_DRY_RUN=true` validates and logs write intent
  without calling Azure.
- **Keep the audit log on.** `AZURE_AUDIT_LOG=true` (default) writes a JSON line per
  guarded operation to stderr.

## Handling of credentials

- The client secret is read from the environment, exchanged for a short-lived ARM
  token against Entra ID, and never logged or returned in tool results.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a
public issue.
