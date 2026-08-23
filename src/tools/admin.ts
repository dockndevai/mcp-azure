import { z } from "zod";
import type { ToolDef } from "./types.js";
import { jsonResult, resolveSub, textResult } from "./types.js";

const subArg = { subscription: z.string().optional().describe("Subscription id (defaults to AZURE_SUBSCRIPTION_ID)") };

/**
 * Admin (destructive) tools. Each needs admin mode + AZURE_ALLOW_DELETE, and —
 * when AZURE_REQUIRE_CONFIRMATION is on — a `confirm` value matching the target name.
 */
export const adminTools: ToolDef[] = [
  {
    name: "delete_resource_group",
    capability: "admin",
    config: {
      title: "Delete resource group",
      description:
        "Permanently delete a resource group and everything in it. Requires admin mode, AZURE_ALLOW_DELETE=true, " +
        "and confirm equal to the resource group name. Irreversible.",
      inputSchema: {
        ...subArg,
        name: z.string().describe("Resource group name"),
        confirm: z.string().optional().describe("Must equal the resource group name to proceed"),
      },
    },
    handler: async (a, ctx) => {
      const sub = resolveSub(a, ctx);
      const name = a.name as string;
      const { dryRun } = ctx.policy.guard({
        tool: "delete_resource_group",
        capability: "admin",
        subscription: sub,
        resourceGroup: name,
        destructive: true,
        confirmExpected: name,
        confirmProvided: a.confirm as string | undefined,
      });
      if (dryRun) return textResult(`[dry-run] Would delete resource group '${name}' and all its resources.`);
      await ctx.client.deleteResourceGroup(sub, name);
      return jsonResult({ deleted: true, resourceGroup: name });
    },
  },
  {
    name: "delete_resource",
    capability: "admin",
    config: {
      title: "Delete a resource",
      description:
        "Permanently delete a single resource by ARM id. Requires admin mode, AZURE_ALLOW_DELETE=true, and confirm " +
        "equal to the resource name. Provide the api-version for the resource type. Irreversible.",
      inputSchema: {
        resourceId: z.string().describe("Full ARM resource id"),
        resourceName: z.string().describe("Resource name — used for the confirmation check"),
        apiVersion: z.string().describe("API version for this resource type"),
        resourceGroup: z.string().optional().describe("Resource group (for scoping/audit)"),
        confirm: z.string().optional().describe("Must equal the resource name to proceed"),
      },
    },
    handler: async (a, ctx) => {
      const name = a.resourceName as string;
      const { dryRun } = ctx.policy.guard({
        tool: "delete_resource",
        capability: "admin",
        resourceGroup: a.resourceGroup as string | undefined,
        destructive: true,
        confirmExpected: name,
        confirmProvided: a.confirm as string | undefined,
      });
      if (dryRun) return textResult(`[dry-run] Would delete resource '${name}' (${a.resourceId}).`);
      await ctx.client.deleteResource(a.resourceId as string, a.apiVersion as string);
      return jsonResult({ deleted: true, resource: name });
    },
  },
];
