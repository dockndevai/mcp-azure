#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`[azure-mcp] Configuration error: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const { server, enabled } = buildServer(config);
  process.stderr.write(
    `[azure-mcp] Starting in '${config.security.mode}' mode` +
      `${config.security.dryRun ? " (DRY RUN)" : ""}. ` +
      `${enabled.length} tools enabled: ${enabled.join(", ")}\n`,
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[azure-mcp] Fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
