import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AzureClient } from "../src/azure/client.js";
import type { AppConfig } from "../src/config.js";
import type { SecurityConfig } from "../src/security.js";
import { buildServer } from "../src/server.js";

const baseSecurity: SecurityConfig = {
  mode: "admin",
  subscriptionAllowlist: [],
  resourceGroupAllowlist: [],
  protectedResourceGroups: [],
  locationAllowlist: [],
  allowDelete: true,
  requireConfirmation: true,
  dryRun: false,
  auditLog: false,
  requireHumanApproval: false,
};

async function connect(security: Partial<SecurityConfig>) {
  const config: AppConfig = {
    connection: { tenantId: "t", clientId: "c", clientSecret: "s", defaultSubscription: "sub-1", requestTimeout: 1000 },
    security: { ...baseSecurity, ...security },
  };
  const { server } = buildServer(config);
  const prompts: string[] = [];
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    prompts.push(req.params.message);
    return { action: "accept", content: { confirm: true, typed: "x" } };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, prompts };
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const res = (rg: string, name = "r") => ({
  id: `/subscriptions/sub-1/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${name}`,
  name,
  type: "Microsoft.Storage/storageAccounts",
  location: "eastus",
});

afterEach(() => vi.restoreAllMocks());

describe("list_resources is filtered by the resource-group allowlist and flags protected groups", () => {
  const arm = [
    res("rg-ok", "a"),
    res("RG-OK", "b"), // same group, other case
    res("rg-secret", "c"), // outside the allowlist
    { id: "/subscriptions/sub-1/providers/Microsoft.Authorization/roleAssignments/ra", name: "ra", type: "x" }, // no resource group
    { name: "no-id", type: "x" }, // group cannot be determined
    { id: "not-an-arm-id", name: "bad", type: "x" }, // group cannot be determined
  ];

  it("subscription-wide listing drops groups outside the allowlist and anything it cannot place (fail closed)", async () => {
    vi.spyOn(AzureClient.prototype, "listResources").mockResolvedValue({ value: arm });
    const { client } = await connect({ resourceGroupAllowlist: ["rg-ok"] });
    const out = await client.callTool({ name: "list_resources", arguments: {} });
    expect(isError(out)).toBe(false);
    const names = (JSON.parse(text(out)) as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(["a", "b"]);
    expect(text(out)).not.toContain("rg-secret");
  });

  it("a group-scoped listing is filtered too (defence in depth if ARM returns a foreign id)", async () => {
    vi.spyOn(AzureClient.prototype, "listResources").mockResolvedValue({ value: [res("rg-ok", "a"), res("rg-secret", "c")] });
    const { client } = await connect({ resourceGroupAllowlist: ["rg-ok"] });
    const out = await client.callTool({ name: "list_resources", arguments: { resourceGroup: "rg-ok" } });
    expect((JSON.parse(text(out)) as Array<{ name: string }>).map((r) => r.name)).toEqual(["a"]);
  });

  it("with no allowlist everything is still listed, and protected groups are flagged", async () => {
    vi.spyOn(AzureClient.prototype, "listResources").mockResolvedValue({ value: [res("rg-prod", "p"), res("RG-PROD", "q"), res("rg-dev", "d")] });
    const { client } = await connect({ protectedResourceGroups: ["rg-prod"] });
    const out = await client.callTool({ name: "list_resources", arguments: {} });
    const items = JSON.parse(text(out)) as Array<{ name: string; protected: boolean }>;
    expect(items.map((i) => [i.name, i.protected])).toEqual([["p", true], ["q", true], ["d", false]]);
  });

  it("with no allowlist an item with no resource group is still listed", async () => {
    vi.spyOn(AzureClient.prototype, "listResources").mockResolvedValue({ value: arm });
    const { client } = await connect({});
    const out = await client.callTool({ name: "list_resources", arguments: {} });
    expect(JSON.parse(text(out))).toHaveLength(arm.length);
  });
});

describe("other list tools do not leak out-of-scope names", () => {
  it("list_resource_groups drops groups outside the allowlist (case-insensitive) and flags protected ones", async () => {
    vi.spyOn(AzureClient.prototype, "listResourceGroups").mockResolvedValue({
      value: [{ name: "RG-OK", location: "eastus" }, { name: "rg-prod", location: "eastus" }, { name: "rg-secret", location: "eastus" }],
    });
    const { client } = await connect({ resourceGroupAllowlist: ["rg-ok", "rg-prod"], protectedResourceGroups: ["RG-PROD"] });
    const out = JSON.parse(text(await client.callTool({ name: "list_resource_groups", arguments: {} }))) as Array<{ name: string; protected: boolean }>;
    expect(out.map((g) => [g.name, g.protected])).toEqual([["RG-OK", false], ["rg-prod", true]]);
  });

  it("list_subscriptions drops subscriptions outside the allowlist; list_locations refuses one", async () => {
    vi.spyOn(AzureClient.prototype, "listSubscriptions").mockResolvedValue({
      value: [{ subscriptionId: "SUB-1", displayName: "a", state: "Enabled" }, { subscriptionId: "sub-2", displayName: "b", state: "Enabled" }],
    });
    const { client } = await connect({ subscriptionAllowlist: ["sub-1"] });
    const subs = JSON.parse(text(await client.callTool({ name: "list_subscriptions", arguments: {} }))) as Array<{ subscriptionId: string }>;
    expect(subs.map((s) => s.subscriptionId)).toEqual(["SUB-1"]);
    const loc = await client.callTool({ name: "list_locations", arguments: { subscription: "sub-2" } });
    expect(isError(loc)).toBe(true);
  });
});

describe("delete_resource binds resourceName to the resource id", () => {
  const ID = "/subscriptions/sub-1/resourceGroups/rg-dev/providers/Microsoft.Storage/storageAccounts/Real-Acct";

  it("refuses a resourceName that is not the id's final segment, before any prompt or request", async () => {
    const del = vi.spyOn(AzureClient.prototype, "deleteResource").mockResolvedValue(undefined);
    const ver = vi.spyOn(AzureClient.prototype, "resourceVersion").mockResolvedValue("e1");
    const { client, prompts } = await connect({});
    const out = await client.callTool({
      name: "delete_resource",
      arguments: { resourceId: ID, resourceName: "harmless-cache", apiVersion: "2023-01-01", confirm: "harmless-cache" },
    });
    expect(isError(out)).toBe(true);
    expect(text(out)).toMatch(/resourceName/);
    expect(prompts).toHaveLength(0);
    expect(ver).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("also refuses in dry-run mode (the mismatch is not previewed as a success)", async () => {
    const { client } = await connect({ dryRun: true });
    const out = await client.callTool({
      name: "delete_resource",
      arguments: { resourceId: ID, resourceName: "harmless-cache", apiVersion: "2023-01-01", confirm: "harmless-cache" },
    });
    expect(isError(out)).toBe(true);
    expect(text(out)).not.toContain("dry-run");
  });

  it("accepts the final segment case-insensitively; the human prompt shows the name from the id, and confirm must equal it", async () => {
    const del = vi.spyOn(AzureClient.prototype, "deleteResource").mockResolvedValue(undefined);
    vi.spyOn(AzureClient.prototype, "resourceVersion").mockResolvedValue("e1");
    const { client, prompts } = await connect({});
    const args = { resourceId: ID, resourceName: "real-acct", apiVersion: "2023-01-01" };
    const wrongConfirm = await client.callTool({ name: "delete_resource", arguments: { ...args, confirm: "real-acct" } });
    expect(isError(wrongConfirm)).toBe(true);
    expect(del).not.toHaveBeenCalled();
    const out = await client.callTool({ name: "delete_resource", arguments: { ...args, confirm: "Real-Acct" } });
    expect(text(out)).toContain('"deleted": true');
    expect(prompts[0]).toContain('delete resource: "Real-Acct"');
    expect(del).toHaveBeenCalledWith(ID, "2023-01-01");
  });
});
