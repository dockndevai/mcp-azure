import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AzureClient, AzureError } from "./azure/client.js";
import type { AppConfig } from "./config.js";
import { canonicalArgs, makeConfirmer } from "./elicit.js";
import { GuardClient, loadGuardConfig } from "./guard.js";
import { PolicyError, SecurityPolicy } from "./security.js";
import { adminTools } from "./tools/admin.js";
import { readTools } from "./tools/read.js";
import { annotationsFor } from "./tools/annotations.js";
import type { ToolContext, ToolDef } from "./tools/types.js";
import { writeTools } from "./tools/write.js";

export const ALL_TOOLS: ToolDef[] = [...readTools, ...writeTools, ...adminTools];

export function buildServer(config: AppConfig): { server: McpServer; enabled: string[] } {
  const policy = new SecurityPolicy(config.security);
  const client = new AzureClient(config.connection);
  const server = new McpServer({ name: "mcp-azure", version: "0.4.0" });
  const guard = new GuardClient(loadGuardConfig());
  const confirmer = makeConfirmer(server, {
    name: "mcp-azure",
    requireHuman: config.security.requireHumanApproval,
    audit: config.security.auditLog,
  });
  const ctx: ToolContext = { client, policy, defaultSubscription: config.connection.defaultSubscription, confirm: confirmer, guard };

  const enabled: string[] = [];
  for (const tool of ALL_TOOLS) {
    if (!policy.isCapabilityEnabled(tool.capability)) continue;
    enabled.push(tool.name);
    server.registerTool(tool.name, { ...tool.config, annotations: annotationsFor(tool) }, async (args: Record<string, unknown>) => {
      try {
        // Every approval prompt in this call is bound to this tool + these exact arguments.
        const callCtx: ToolContext = { ...ctx, confirm: confirmer.forCall(tool.name, args ?? {}) };
        // laya-guard: assess every mutating op before it runs (no-op unless *_GUARD_MODE is set).
        if (tool.capability !== "read") {
          await guard.enforce({ tool: tool.name, command: `${tool.name} ${canonicalArgs(args ?? {})}`, context: tool.name }, callCtx.confirm);
        }
        return await tool.handler(args ?? {}, callCtx);
      } catch (err) {
        return toErrorResult(err);
      }
    });
  }
  return { server, enabled };
}

function toErrorResult(err: unknown) {
  let message: string;
  if (err instanceof PolicyError) message = `Policy denied: ${err.message}`;
  else if (err instanceof AzureError) message = `Azure error (${err.status}): ${err.message}${err.body ? `\n${truncate(err.body)}` : ""}`;
  else if (err instanceof Error) message = `${err.name}: ${err.message}`;
  else message = String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function truncate(s: string, max = 800): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
