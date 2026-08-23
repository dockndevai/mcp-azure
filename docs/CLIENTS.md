# Installing `@dockndevai/mcp-azure` in your MCP client

A **stdio** MCP server. Published on npm — your MCP client runs it with `npx` (no clone needed), or run from a local build. **Start in `read-only` mode.** See [`.env.example`](../.env.example) for every variable.

## Claude Code (CLI)

```bash
claude mcp add azure -e AZURE_TENANT_ID="your-tenant-id" -e AZURE_CLIENT_ID="your-client-id" -e AZURE_CLIENT_SECRET="your-secret" -e AZURE_SUBSCRIPTION_ID="your-subscription-id" -e AZURE_MODE="read-only" -- npx -y @dockndevai/mcp-azure
```

## Claude Desktop · Cursor · Windsurf

Merge into `claude_desktop_config.json`, `.cursor/mcp.json`, or `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "azure": {
      "command": "npx",
      "args": [
        "-y",
        "@dockndevai/mcp-azure"
      ],
      "env": {
        "AZURE_TENANT_ID": "your-tenant-id",
        "AZURE_CLIENT_ID": "your-client-id",
        "AZURE_CLIENT_SECRET": "your-secret",
        "AZURE_SUBSCRIPTION_ID": "your-subscription-id",
        "AZURE_MODE": "read-only"
      }
    }
  }
}
```

## OpenAI Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.azure]
command = "npx"
args = ["-y", "@dockndevai/mcp-azure"]
env = { AZURE_TENANT_ID = "your-tenant-id", AZURE_CLIENT_ID = "your-client-id", AZURE_CLIENT_SECRET = "your-secret", AZURE_SUBSCRIPTION_ID = "your-subscription-id", AZURE_MODE = "read-only" }
```

## VS Code (GitHub Copilot, Agent mode) — `.vscode/mcp.json`

```json
{
  "servers": {
    "azure": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@dockndevai/mcp-azure"
      ],
      "env": {
        "AZURE_TENANT_ID": "your-tenant-id",
        "AZURE_CLIENT_ID": "your-client-id",
        "AZURE_CLIENT_SECRET": "your-secret",
        "AZURE_SUBSCRIPTION_ID": "your-subscription-id",
        "AZURE_MODE": "read-only"
      }
    }
  }
}
```

## From a local build

```json
{
  "mcpServers": {
    "azure": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/mcp-azure/dist/index.js"
      ],
      "env": {
        "AZURE_TENANT_ID": "your-tenant-id",
        "AZURE_CLIENT_ID": "your-client-id",
        "AZURE_CLIENT_SECRET": "your-secret",
        "AZURE_SUBSCRIPTION_ID": "your-subscription-id",
        "AZURE_MODE": "read-only"
      }
    }
  }
}
```

## Verify

On startup the server logs to **stderr**: `[azure-mcp] Starting in 'read-only' mode. N tools enabled: …`. Ask your agent to list the Azure tools to confirm.
