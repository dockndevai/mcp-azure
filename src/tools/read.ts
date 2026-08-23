import { z } from "zod";
import type { ToolDef } from "./types.js";
import { jsonResult, resolveSub } from "./types.js";

const subArg = { subscription: z.string().optional().describe("Subscription id (defaults to AZURE_SUBSCRIPTION_ID)") };

export const readTools: ToolDef[] = [
  {
    name: "list_subscriptions",
    capability: "read",
    config: { title: "List subscriptions", description: "List subscriptions the service principal can see (filtered by allowlist).", inputSchema: {} },
    handler: async (_a, { client, policy }) => {
      policy.guard({ tool: "list_subscriptions", capability: "read" });
      const data = (await client.listSubscriptions()) as { value?: Array<{ subscriptionId: string; displayName: string; state: string }> };
      const subs = (data.value ?? [])
        .filter((s) => policy.isSubscriptionAllowed(s.subscriptionId))
        .map((s) => ({ subscriptionId: s.subscriptionId, displayName: s.displayName, state: s.state }));
      return jsonResult(subs);
    },
  },
  {
    name: "list_locations",
    capability: "read",
    config: { title: "List locations", description: "List the regions available to a subscription.", inputSchema: { ...subArg } },
    handler: async (a, ctx) => {
      const sub = resolveSub(a, ctx);
      ctx.policy.guard({ tool: "list_locations", capability: "read", subscription: sub });
      return jsonResult(await ctx.client.listLocations(sub));
    },
  },
  {
    name: "list_resource_groups",
    capability: "read",
    config: { title: "List resource groups", description: "List resource groups in a subscription (filtered by allowlist).", inputSchema: { ...subArg } },
    handler: async (a, ctx) => {
      const sub = resolveSub(a, ctx);
      ctx.policy.guard({ tool: "list_resource_groups", capability: "read", subscription: sub });
      const data = (await ctx.client.listResourceGroups(sub)) as { value?: Array<{ name: string; location: string }> };
      const groups = (data.value ?? [])
        .filter((g) => ctx.policy.isResourceGroupAllowed(g.name))
        .map((g) => ({ name: g.name, location: g.location, protected: ctx.policy.isResourceGroupProtected(g.name) }));
      return jsonResult(groups);
    },
  },
  {
    name: "list_resources",
    capability: "read",
    config: {
      title: "List resources",
      description: "List resources in a subscription, or within a specific resource group.",
      inputSchema: { ...subArg, resourceGroup: z.string().optional().describe("Limit to this resource group") },
    },
    handler: async (a, ctx) => {
      const sub = resolveSub(a, ctx);
      const rg = a.resourceGroup as string | undefined;
      ctx.policy.guard({ tool: "list_resources", capability: "read", subscription: sub, resourceGroup: rg });
      const data = (await ctx.client.listResources(sub, rg)) as { value?: Array<Record<string, unknown>> };
      const items = (data.value ?? []).map((r) => ({ id: r.id, name: r.name, type: r.type, location: r.location, kind: r.kind }));
      return jsonResult(items);
    },
  },
  {
    name: "get_resource",
    capability: "read",
    config: {
      title: "Get resource",
      description: "Fetch a resource by its full ARM id. Provide the api-version for the resource type.",
      inputSchema: {
        resourceId: z.string().describe("Full ARM resource id (/subscriptions/…/providers/…)"),
        apiVersion: z.string().describe("API version for this resource type, e.g. 2023-07-01"),
      },
    },
    handler: async (a, ctx) => {
      ctx.policy.guard({ tool: "get_resource", capability: "read" });
      return jsonResult(await ctx.client.getResource(a.resourceId as string, a.apiVersion as string));
    },
  },
];
