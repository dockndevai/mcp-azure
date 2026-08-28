import type { ZodRawShape } from "zod";
import type { AzureClient } from "../azure/client.js";
import type { Capability, SecurityPolicy } from "../security.js";

export interface ToolContext {
  client: AzureClient;
  policy: SecurityPolicy;
  defaultSubscription?: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  capability: Capability;
  /** Marks a mutating tool as destructive (data loss possible). Defaults to `capability === "admin"`. */
  destructive?: boolean;
  /** Overrides the idempotency hint. Defaults to `true` for read tools, `false` otherwise. */
  idempotent?: boolean;
  config: { title: string; description: string; inputSchema: Shape };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Resolve the subscription for a call: explicit arg, else the configured default. */
export function resolveSub(args: Record<string, unknown>, ctx: ToolContext): string {
  const sub = (args.subscription as string | undefined) ?? ctx.defaultSubscription;
  if (!sub) throw new Error("No subscription provided and AZURE_SUBSCRIPTION_ID is not set.");
  return sub;
}
