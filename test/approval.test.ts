import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AzureClient } from "../src/azure/client.js";
import type { AppConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

const config = (requireHumanApproval = false, requireConfirmation = true): AppConfig => ({
  connection: { tenantId: "t", clientId: "c", clientSecret: "s", defaultSubscription: "sub-1", requestTimeout: 1000 },
  security: {
    mode: "admin",
    subscriptionAllowlist: [],
    resourceGroupAllowlist: [],
    protectedResourceGroups: [],
    locationAllowlist: [],
    allowDelete: true,
    requireConfirmation,
    dryRun: false,
    auditLog: false,
    requireHumanApproval,
  },
});

type Answer = { action: "accept" | "decline"; content?: Record<string, unknown> };

/** Connect an in-memory MCP client (optionally able to answer elicitation) to a freshly built server. */
async function connect(opts: {
  requireHuman?: boolean;
  requireConfirmation?: boolean;
  answer?: (message: string) => Answer | Promise<Answer>;
  elicits?: boolean;
}) {
  const { server } = buildServer(config(opts.requireHuman, opts.requireConfirmation));
  const prompts: string[] = [];
  const client = new Client({ name: "t", version: "0" }, { capabilities: opts.elicits === false ? {} : { elicitation: {} } });
  if (opts.elicits !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return (await opts.answer?.(req.params.message)) ?? { action: "accept", content: { confirm: true, typed: "rg-prod" } };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, prompts };
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const RG = { name: "rg-prod", confirm: "rg-prod" };
const RES = {
  resourceId: "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Storage/storageAccounts/acct",
  resourceName: "acct",
  apiVersion: "2023-01-01",
  confirm: "acct",
};

afterEach(() => vi.restoreAllMocks());

describe("delete_resource_group approval (end to end)", () => {
  it("shows the tool, full arguments, version and fingerprint, then deletes", async () => {
    vi.spyOn(AzureClient.prototype, "resourceGroupVersion").mockResolvedValue("v1");
    const del = vi.spyOn(AzureClient.prototype, "deleteResourceGroup").mockResolvedValue(undefined);
    const { client, prompts } = await connect({});
    const res = await client.callTool({ name: "delete_resource_group", arguments: RG });
    expect(text(res)).toContain('"deleted": true');
    expect(del).toHaveBeenCalledWith("sub-1", "rg-prod");
    expect(prompts[0]).toContain("tool: delete_resource_group");
    expect(prompts[0]).toContain('{"confirm":"rg-prod","name":"rg-prod"}');
    expect(prompts[0]).toContain("resource version: v1");
    expect(prompts[0]).toMatch(/fingerprint: [0-9a-f]{16}/);
  });

  it("does NOT delete when the group's contents changed while the human was deciding", async () => {
    const versions = ["v1", "v2"];
    vi.spyOn(AzureClient.prototype, "resourceGroupVersion").mockImplementation(async () => versions.shift());
    const del = vi.spyOn(AzureClient.prototype, "deleteResourceGroup").mockResolvedValue(undefined);
    const { client } = await connect({});
    const res = await client.callTool({ name: "delete_resource_group", arguments: RG });
    expect(text(res)).toContain("resource changed since the prompt");
    expect(del).not.toHaveBeenCalled();
  });

  it("does NOT delete when the human types the wrong name", async () => {
    vi.spyOn(AzureClient.prototype, "resourceGroupVersion").mockResolvedValue("v1");
    const del = vi.spyOn(AzureClient.prototype, "deleteResourceGroup").mockResolvedValue(undefined);
    const { client } = await connect({ answer: () => ({ action: "accept", content: { confirm: true, typed: "rg-dev" } }) });
    const res = await client.callTool({ name: "delete_resource_group", arguments: RG });
    expect(text(res)).toContain("typed confirmation did not match");
    expect(del).not.toHaveBeenCalled();
  });

  it("does NOT delete when the human declines", async () => {
    vi.spyOn(AzureClient.prototype, "resourceGroupVersion").mockResolvedValue("v1");
    const del = vi.spyOn(AzureClient.prototype, "deleteResourceGroup").mockResolvedValue(undefined);
    const { client } = await connect({ answer: () => ({ action: "decline" }) });
    await client.callTool({ name: "delete_resource_group", arguments: RG });
    expect(del).not.toHaveBeenCalled();
  });

  it("keeps the model-supplied `confirm` argument gate: no prompt, no delete when it is wrong", async () => {
    const probe = vi.spyOn(AzureClient.prototype, "resourceGroupVersion").mockResolvedValue("v1");
    const del = vi.spyOn(AzureClient.prototype, "deleteResourceGroup").mockResolvedValue(undefined);
    const { client, prompts } = await connect({});
    const res = await client.callTool({ name: "delete_resource_group", arguments: { name: "rg-prod", confirm: "nope" } });
    expect(text(res)).toContain('Re-run with confirm="rg-prod"');
    expect(prompts).toHaveLength(0);
    expect(probe).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("still asks the human to type the name when AZURE_REQUIRE_CONFIRMATION=false", async () => {
    vi.spyOn(AzureClient.prototype, "resourceGroupVersion").mockResolvedValue("v1");
    const del = vi.spyOn(AzureClient.prototype, "deleteResourceGroup").mockResolvedValue(undefined);
    const { client, prompts } = await connect({
      requireConfirmation: false,
      answer: () => ({ action: "accept", content: { confirm: true, typed: "wrong" } }),
    });
    const res = await client.callTool({ name: "delete_resource_group", arguments: { name: "rg-prod" } });
    expect(prompts).toHaveLength(1);
    expect(text(res)).toContain("typed confirmation did not match");
    expect(del).not.toHaveBeenCalled();
  });
});

describe("AZURE_REQUIRE_HUMAN_APPROVAL", () => {
  it("falls back to the flags when the client cannot elicit (default)", async () => {
    vi.spyOn(AzureClient.prototype, "resourceGroupVersion").mockResolvedValue("v1");
    const del = vi.spyOn(AzureClient.prototype, "deleteResourceGroup").mockResolvedValue(undefined);
    const { client } = await connect({ elicits: false });
    await client.callTool({ name: "delete_resource_group", arguments: RG });
    expect(del).toHaveBeenCalledWith("sub-1", "rg-prod");
  });

  it("refuses to delete, without any prompt, when the client cannot elicit and a human is required", async () => {
    vi.spyOn(AzureClient.prototype, "resourceGroupVersion").mockResolvedValue("v1");
    const del = vi.spyOn(AzureClient.prototype, "deleteResourceGroup").mockResolvedValue(undefined);
    const { client, prompts } = await connect({ elicits: false, requireHuman: true });
    const res = await client.callTool({ name: "delete_resource_group", arguments: RG });
    expect(text(res)).toContain("no human approval channel");
    expect(prompts).toHaveLength(0);
    expect(del).not.toHaveBeenCalled();
  });
});

describe("other destructive tools bind their version too", () => {
  it("delete_resource refuses when the resource's etag changed", async () => {
    const versions = ["e1", "e2"];
    vi.spyOn(AzureClient.prototype, "resourceVersion").mockImplementation(async () => versions.shift());
    const del = vi.spyOn(AzureClient.prototype, "deleteResource").mockResolvedValue(undefined);
    const { client, prompts } = await connect({});
    const res = await client.callTool({ name: "delete_resource", arguments: RES });
    expect(prompts[0]).toContain("tool: delete_resource");
    expect(prompts[0]).toContain("resource version: e1");
    expect(text(res)).toContain("resource changed since the prompt");
    expect(del).not.toHaveBeenCalled();
  });

  it("delete_resource proceeds when the version is stable", async () => {
    vi.spyOn(AzureClient.prototype, "resourceVersion").mockResolvedValue("e1");
    const del = vi.spyOn(AzureClient.prototype, "deleteResource").mockResolvedValue(undefined);
    const { client } = await connect({});
    const res = await client.callTool({ name: "delete_resource", arguments: RES });
    expect(text(res)).toContain('"deleted": true');
    expect(del).toHaveBeenCalledWith(RES.resourceId, RES.apiVersion);
  });

  it("control_vm powerOff refuses when the VM was replaced while the human was deciding", async () => {
    const versions = ["vm-a", "vm-b"];
    vi.spyOn(AzureClient.prototype, "vmVersion").mockImplementation(async () => versions.shift());
    const ctl = vi.spyOn(AzureClient.prototype, "controlVm").mockResolvedValue(undefined);
    const { client } = await connect({});
    const res = await client.callTool({
      name: "control_vm",
      arguments: { resourceGroup: "rg-prod", vmName: "web1", action: "powerOff" },
    });
    expect(text(res)).toContain("resource changed since the prompt");
    expect(ctl).not.toHaveBeenCalled();
  });

  it("control_vm start needs no approval and reads no version", async () => {
    const probe = vi.spyOn(AzureClient.prototype, "vmVersion").mockResolvedValue("vm-a");
    const ctl = vi.spyOn(AzureClient.prototype, "controlVm").mockResolvedValue(undefined);
    const { client, prompts } = await connect({});
    await client.callTool({ name: "control_vm", arguments: { resourceGroup: "rg-prod", vmName: "web1", action: "start" } });
    expect(prompts).toHaveLength(0);
    expect(probe).not.toHaveBeenCalled();
    expect(ctl).toHaveBeenCalled();
  });
});
