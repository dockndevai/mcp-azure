import type { ZodRawShape } from "zod";
import type { Confirmer } from "../elicit.js";
import type { GuardClient } from "../guard.js";
import type { AzureClient } from "../azure/client.js";
import { assertSegment, parseResourceId, type ResourceScope } from "../azure/resource-id.js";
import { PolicyError, type Capability, type SecurityPolicy } from "../security.js";

export interface ToolContext {
  client: AzureClient;
  policy: SecurityPolicy;
  defaultSubscription?: string;
  /** Human-in-the-loop confirmation for destructive ops (no-op fallback when the client can't elicit). */
  confirm: Confirmer;
  /** Optional AI risk gate (laya-guard). Off unless AZURE_GUARD_MODE is set. */
  guard: GuardClient;
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
/**
 * A listing result. A complete listing is the plain array. When the page cap was hit it is wrapped so the
 * truncation is explicit: a partial list must never read as a complete one (especially after allowlist filtering,
 * where "not shown" would otherwise look like "does not exist").
 */
export function listResult(items: unknown[], truncated: boolean | undefined): ToolResult {
  if (!truncated) return jsonResult(items);
  return jsonResult({
    truncated: true,
    note: "Incomplete: the page limit was reached before the end of the listing, so entries are missing (and any allowlist filter was applied only to the pages read). Narrow the query where possible (for list_resources, pass resourceGroup).",
    items,
  });
}
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Resolve the subscription for a call: explicit arg, else the configured default. */
export function resolveSub(args: Record<string, unknown>, ctx: ToolContext): string {
  const sub = (args.subscription as string | undefined) ?? ctx.defaultSubscription;
  if (!sub) throw new Error("No subscription provided and AZURE_SUBSCRIPTION_ID is not set.");
  return assertSegment(sub, "subscription id");
}

/**
 * Scope for a tool that targets one resource by ARM id. The subscription and resource group come from the ID
 * (that is what ARM will act on); an optional `subscription` / `resourceGroup` argument is only an assertion and
 * must agree with it. Policy must be evaluated on the returned values, never on the arguments.
 */
export function resolveResourceScope(
  args: Record<string, unknown>,
  opts: { requireResource?: boolean } = {},
): ResourceScope {
  const scope = parseResourceId(args.resourceId, opts);
  const claimed: Array<[string, unknown, string | undefined]> = [
    ["subscription", args.subscription, scope.subscription],
    ["resourceGroup", args.resourceGroup, scope.resourceGroup],
  ];
  for (const [name, supplied, actual] of claimed) {
    if (supplied === undefined || supplied === null || supplied === "") continue;
    if (typeof supplied !== "string" || actual === undefined || supplied.toLowerCase() !== actual.toLowerCase()) {
      throw new PolicyError(
        `The supplied ${name} '${String(supplied)}' does not match the resource id (${actual ?? "none"}); policy is evaluated on the id.`,
      );
    }
  }
  return scope;
}
