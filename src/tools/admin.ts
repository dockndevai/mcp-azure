import { z } from "zod";
import type { ToolDef } from "./types.js";
import { assertSegment, resourceNameOf } from "../azure/resource-id.js";
import { jsonResult, resolveResourceScope, resolveSub, textResult } from "./types.js";
import { PolicyError } from "../security.js";

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
      const name = assertSegment(a.name, "resource group name");
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
      // typed: the human must also type the group name. This is separate from (and in addition to) the
      // model-supplied `confirm` argument checked by policy.guard above, which a human never sees.
      const ok = await ctx.confirm.confirm({
        action: "delete resource group (and everything in it)",
        target: name,
        details: { subscription: sub },
        typed: true,
        probe: () => ctx.client.resourceGroupVersion(sub, name),
      });
      if (!ok.approved) return textResult(`Deletion cancelled — ${ok.reason}.`);
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
        resourceName: z.string().describe("Resource name — must equal the final segment of resourceId (case-insensitive); the confirmation check and the approval prompt use the name from the id"),
        apiVersion: z.string().describe("API version for this resource type"),
        subscription: z.string().optional().describe("Optional; must match the subscription in resourceId (policy is evaluated on the id)"),
        resourceGroup: z.string().optional().describe("Optional; must match the resource group in resourceId (policy is evaluated on the id)"),
        confirm: z.string().optional().describe("Must equal the resource name (the final segment of resourceId) to proceed"),
      },
    },
    handler: async (a, ctx) => {
      // Scope comes from the id: it is what ARM will delete. A bare subscription / resource-group id is refused
      // (resource groups go through delete_resource_group and its typed prompt).
      const scope = resolveResourceScope(a, { requireResource: true });
      // The name the human is shown and the `confirm` is checked against is derived from the id, never taken from
      // the model: `resourceName` is only an assertion and must be the id's final segment (ARM names are
      // case-insensitive). Otherwise a model could pair a destructive id with a harmless-looking name.
      const name = resourceNameOf(scope.id);
      if (typeof a.resourceName !== "string" || a.resourceName.toLowerCase() !== name.toLowerCase()) {
        throw new PolicyError(
          `resourceName '${String(a.resourceName)}' does not match the resource id, whose resource name is '${name}'; policy and confirmation are evaluated on the id.`,
        );
      }
      const { dryRun } = ctx.policy.guard({
        tool: "delete_resource",
        capability: "admin",
        subscription: scope.subscription,
        resourceGroup: scope.resourceGroup,
        resourceGroupRequired: true,
        destructive: true,
        confirmExpected: name,
        confirmProvided: a.confirm as string | undefined,
      });
      if (dryRun) return textResult(`[dry-run] Would delete resource '${name}' (${scope.id}).`);
      const resourceId = scope.id;
      const apiVersion = a.apiVersion as string;
      const ok = await ctx.confirm.confirm({
        action: "delete resource",
        target: name,
        details: { id: resourceId },
        probe: () => ctx.client.resourceVersion(resourceId, apiVersion),
      });
      if (!ok.approved) return textResult(`Deletion cancelled — ${ok.reason}.`);
      await ctx.client.deleteResource(resourceId, apiVersion);
      return jsonResult({ deleted: true, resource: name });
    },
  },
];
