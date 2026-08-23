import { z } from "zod";
import type { ToolDef } from "./types.js";
import { jsonResult, resolveSub, textResult } from "./types.js";

const subArg = { subscription: z.string().optional().describe("Subscription id (defaults to AZURE_SUBSCRIPTION_ID)") };

export const writeTools: ToolDef[] = [
  {
    name: "create_resource_group",
    capability: "write",
    config: {
      title: "Create resource group",
      description: "Create a resource group in an approved location.",
      inputSchema: {
        ...subArg,
        name: z.string().describe("Resource group name"),
        location: z.string().describe("Azure region, e.g. eastus"),
        tags: z.record(z.string()).optional().describe("Optional tags"),
      },
    },
    handler: async (a, ctx) => {
      const sub = resolveSub(a, ctx);
      const name = a.name as string;
      const location = a.location as string;
      const { dryRun } = ctx.policy.guard({
        tool: "create_resource_group",
        capability: "write",
        subscription: sub,
        resourceGroup: name,
        location,
      });
      if (dryRun) return textResult(`[dry-run] Would create resource group '${name}' in ${location}.`);
      return jsonResult(await ctx.client.createResourceGroup(sub, name, location, a.tags as Record<string, string> | undefined));
    },
  },
  {
    name: "tag_resource",
    capability: "write",
    config: {
      title: "Tag a resource",
      description: "Merge tags onto any resource by its ARM id (uses the generic Tags API).",
      inputSchema: {
        ...subArg,
        resourceId: z.string().describe("Full ARM resource id"),
        resourceGroup: z.string().optional().describe("Resource group (for scoping/audit)"),
        tags: z.record(z.string()).describe("Tags to merge, e.g. { \"env\": \"prod\", \"owner\": \"team-a\" }"),
      },
    },
    handler: async (a, ctx) => {
      const sub = resolveSub(a, ctx);
      const { dryRun } = ctx.policy.guard({
        tool: "tag_resource",
        capability: "write",
        subscription: sub,
        resourceGroup: a.resourceGroup as string | undefined,
      });
      if (dryRun) return textResult(`[dry-run] Would merge tags onto ${a.resourceId}: ${JSON.stringify(a.tags)}`);
      return jsonResult(await ctx.client.tagResource(a.resourceId as string, a.tags as Record<string, string>));
    },
  },
  {
    name: "control_vm",
    capability: "write",
    config: {
      title: "Control a VM (power state)",
      description: "Start, stop (deallocate), power off, or restart a virtual machine.",
      inputSchema: {
        ...subArg,
        resourceGroup: z.string().describe("Resource group of the VM"),
        vmName: z.string().describe("Virtual machine name"),
        action: z.enum(["start", "powerOff", "restart", "deallocate"]).describe("Power action"),
      },
    },
    handler: async (a, ctx) => {
      const sub = resolveSub(a, ctx);
      const rg = a.resourceGroup as string;
      const { dryRun } = ctx.policy.guard({ tool: "control_vm", capability: "write", subscription: sub, resourceGroup: rg });
      if (dryRun) return textResult(`[dry-run] Would ${a.action} VM ${a.vmName} in ${rg}.`);
      await ctx.client.controlVm(sub, rg, a.vmName as string, a.action as string);
      return jsonResult({ ok: true, vm: a.vmName, action: a.action, resourceGroup: rg });
    },
  },
];
