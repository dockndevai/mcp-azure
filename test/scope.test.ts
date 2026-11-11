import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AzureClient } from "../src/azure/client.js";
import type { AppConfig } from "../src/config.js";
import { parseResourceId } from "../src/azure/resource-id.js";
import type { SecurityConfig } from "../src/security.js";
import { buildServer } from "../src/server.js";

/** Every outbound request, token endpoint included. A foreign host or a stray token request shows up here. */
function stubFetch() {
  const calls: Array<{ url: string; host: string; method: string; auth?: string }> = [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: { method?: string; headers?: Record<string, string> }) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), host: url.host, method: init?.method ?? "GET", auth: init?.headers?.Authorization });
    const body = url.host === "login.microsoftonline.com" ? { access_token: "SECRET-TOKEN", expires_in: 3600 } : { id: "x", etag: "e1" };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const azure = () => new AzureClient({ tenantId: "t", clientId: "c", clientSecret: "s", requestTimeout: 1000 });
const ID = "/subscriptions/sub-1/resourceGroups/rg-ok/providers/Microsoft.Storage/storageAccounts/acct";

describe("ARM client never sends the bearer token off ARM", () => {
  const foreign = [
    "https://attacker.example/subscriptions/sub-1/x",
    "http://attacker.example/x",
    "HTTPS://attacker.example/x",
    "https://management.azure.com.attacker.example/subscriptions/sub-1",
    "https://management.azure.com@attacker.example/subscriptions/sub-1",
    "https://attacker.example\\@management.azure.com/subscriptions/sub-1",
    "http://management.azure.com/subscriptions/sub-1", // right host, downgraded scheme
    "https://management.azure.com:8443/subscriptions/sub-1", // right host, other port
    "//attacker.example/subscriptions/sub-1",
    "@attacker.example/subscriptions/sub-1",
    "attacker.example/subscriptions/sub-1",
    "/subscriptions/sub-1/../../../x",
    "/subscriptions/sub-1/%2e%2e/%2e%2e/x",
    "/subscriptions/sub-1?x=1#frag",
    "/subscriptions/sub-1/resourceGroups/rg\\..\\..\\x",
  ];

  it.each(foreign)("request(%s) is rejected before any token is requested or any request is made", async (target) => {
    const calls = stubFetch();
    await expect(azure().request("GET", target, { apiVersion: "2021-04-01" })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it.each(foreign)("getResource / deleteResource / tagResource(%s) are rejected with no outbound request", async (target) => {
    const calls = stubFetch();
    const c = azure();
    await expect(c.getResource(target, "2023-01-01")).rejects.toThrow();
    await expect(c.deleteResource(target, "2023-01-01")).rejects.toThrow();
    await expect(c.tagResource(target, { a: "b" })).rejects.toThrow();
    await expect(c.resourceVersion(target, "2023-01-01")).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("still sends a valid ARM id to management.azure.com with the token", async () => {
    const calls = stubFetch();
    await azure().getResource(ID, "2023-01-01");
    const arm = calls.filter((c) => c.host !== "login.microsoftonline.com");
    expect(arm).toHaveLength(1);
    expect(arm[0]!.url).toBe(`https://management.azure.com${ID}?api-version=2023-01-01`);
    expect(arm[0]!.auth).toBe("Bearer SECRET-TOKEN");
  });

  it("still follows a nextLink on the ARM host", async () => {
    const calls = stubFetch();
    await azure().request("GET", "https://management.azure.com/subscriptions/sub-1/resources?$skiptoken=abc", { apiVersion: "2021-04-01" });
    expect(calls.some((c) => c.host === "management.azure.com" && new URL(c.url).pathname === "/subscriptions/sub-1/resources")).toBe(true);
  });

  it("rejects names that would escape their path segment in the builders (sub / rg / vm / group name)", async () => {
    const calls = stubFetch();
    const c = azure();
    await expect(c.deleteResourceGroup("sub-1", "x/../prod")).rejects.toThrow();
    await expect(c.listResources("sub-1", "../../sub-2/resourceGroups/prod")).rejects.toThrow();
    await expect(c.controlVm("sub-1", "rg", "vm/../../x", "powerOff")).rejects.toThrow();
    await expect(c.createResourceGroup("sub-1/../sub-2", "rg", "eastus")).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("parseResourceId", () => {
  it("extracts subscription and resource group", () => {
    expect(parseResourceId(ID)).toEqual({ id: ID, subscription: "sub-1", resourceGroup: "rg-ok" });
    expect(parseResourceId("/subscriptions/sub-1/resourcegroups/RG")).toMatchObject({ subscription: "sub-1", resourceGroup: "RG" });
    const subScoped = parseResourceId("/subscriptions/sub-1/providers/Microsoft.Authorization/roleAssignments/ra");
    expect(subScoped.resourceGroup).toBeUndefined();
  });
  it.each(["", "subscriptions/s", "/providers/Microsoft.X/y/z", "/subscriptions", "/subscriptions/s/resourceGroups", "/subscriptions/s/resourceGroups/rg/", "/subscriptions/s/foo/bar", "/subscriptions/s/resourceGroups/rg/providers/Microsoft.X"])(
    "rejects %j",
    (bad) => {
      expect(() => parseResourceId(bad)).toThrow();
    },
  );
  it("requireResource refuses a bare subscription or resource group id", () => {
    expect(() => parseResourceId("/subscriptions/s/resourceGroups/rg", { requireResource: true })).toThrow(/single resource/);
    expect(() => parseResourceId("/subscriptions/s", { requireResource: true })).toThrow(/single resource/);
    expect(() => parseResourceId(ID, { requireResource: true })).not.toThrow();
  });
});

// ---- scope checks go through the real tool handlers ---------------------------------------------------

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
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { confirm: true, typed: "x" } }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const idIn = (sub: string, rg: string) => `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/acct`;
const del = (resourceId: string, extra: Record<string, unknown> = {}) => ({
  name: "delete_resource",
  arguments: { resourceId, resourceName: "acct", apiVersion: "2023-01-01", confirm: "acct", ...extra },
});

describe("exfiltration through the tools", () => {
  it.each([
    ["get_resource", { resourceId: "https://attacker.example/subscriptions/s/x", apiVersion: "2023-01-01" }],
    ["tag_resource", { resourceId: "https://attacker.example/subscriptions/s/x", tags: { a: "b" } }],
    ["delete_resource", { resourceId: "https://attacker.example/subscriptions/s/x", resourceName: "x", apiVersion: "2023-01-01", confirm: "x" }],
  ])("%s with a foreign resourceId makes no outbound request and acquires no token", async (name, args) => {
    const calls = stubFetch();
    const client = await connect({});
    const res = await client.callTool({ name, arguments: args });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("scope is enforced on the subscription / resource group PARSED from the resource id", () => {
  it("get_resource: resource group allowlist applies (it previously passed no resource group at all)", async () => {
    const calls = stubFetch();
    const client = await connect({ resourceGroupAllowlist: ["rg-ok"] });
    const denied = await client.callTool({ name: "get_resource", arguments: { resourceId: idIn("sub-1", "rg-secret"), apiVersion: "2023-01-01" } });
    expect(text(denied)).toMatch(/allowlist/);
    expect(calls).toEqual([]);
    const ok = await client.callTool({ name: "get_resource", arguments: { resourceId: idIn("sub-1", "rg-ok"), apiVersion: "2023-01-01" } });
    expect((ok as { isError?: boolean }).isError).toBeFalsy();
  });

  it("get_resource: subscription allowlist applies", async () => {
    const calls = stubFetch();
    const client = await connect({ subscriptionAllowlist: ["sub-1"] });
    const res = await client.callTool({ name: "get_resource", arguments: { resourceId: idIn("sub-2", "rg-ok"), apiVersion: "2023-01-01" } });
    expect(text(res)).toMatch(/allowlist/);
    expect(calls).toEqual([]);
  });

  it("get_resource: a subscription-scoped id is outside every allowed resource group", async () => {
    const calls = stubFetch();
    const client = await connect({ resourceGroupAllowlist: ["rg-ok"] });
    const res = await client.callTool({
      name: "get_resource",
      arguments: { resourceId: "/subscriptions/sub-1/providers/Microsoft.Authorization/roleAssignments/ra", apiVersion: "2022-04-01" },
    });
    expect(text(res)).toMatch(/resource group/i);
    expect(calls).toEqual([]);
  });

  it("tag_resource: omitting resourceGroup no longer skips the protected-group check", async () => {
    const calls = stubFetch();
    const client = await connect({ protectedResourceGroups: ["rg-prod"] });
    const res = await client.callTool({ name: "tag_resource", arguments: { resourceId: idIn("sub-1", "rg-prod"), tags: { a: "b" } } });
    expect(text(res)).toMatch(/protected/);
    expect(calls).toEqual([]);
  });

  it("tag_resource: a supplied resourceGroup that disagrees with the id is rejected", async () => {
    const calls = stubFetch();
    const client = await connect({ protectedResourceGroups: ["rg-prod"] });
    const res = await client.callTool({
      name: "tag_resource",
      arguments: { resourceId: idIn("sub-1", "rg-prod"), resourceGroup: "rg-dev", tags: { a: "b" } },
    });
    expect(text(res)).toMatch(/does not match/);
    expect(calls).toEqual([]);
  });

  it("tag_resource: the subscription comes from the id, not the default / supplied argument", async () => {
    const calls = stubFetch();
    const client = await connect({ subscriptionAllowlist: ["sub-1"] });
    // default subscription (sub-1) is allowed; the resource lives in sub-2.
    const res = await client.callTool({ name: "tag_resource", arguments: { resourceId: idIn("sub-2", "rg-ok"), tags: { a: "b" } } });
    expect(text(res)).toMatch(/allowlist/);
    const mismatch = await client.callTool({
      name: "tag_resource",
      arguments: { resourceId: idIn("sub-2", "rg-ok"), subscription: "sub-1", tags: { a: "b" } },
    });
    expect(text(mismatch)).toMatch(/does not match/);
    expect(calls).toEqual([]);
  });

  it("delete_resource: omitting resourceGroup no longer skips the protected-group check", async () => {
    const calls = stubFetch();
    const client = await connect({ protectedResourceGroups: ["rg-prod"] });
    const res = await client.callTool(del(idIn("sub-1", "rg-prod")));
    expect(text(res)).toMatch(/protected/);
    expect(calls).toEqual([]);
  });

  it("delete_resource: a decoy resourceGroup argument cannot launder a protected or non-allowlisted target", async () => {
    const calls = stubFetch();
    const client = await connect({ protectedResourceGroups: ["rg-prod"], resourceGroupAllowlist: ["rg-prod", "rg-dev"] });
    const res = await client.callTool(del(idIn("sub-1", "rg-prod"), { resourceGroup: "rg-dev" }));
    expect(text(res)).toMatch(/does not match/);
    expect(calls).toEqual([]);
  });

  it("delete_resource: the subscription allowlist now applies", async () => {
    const calls = stubFetch();
    const client = await connect({ subscriptionAllowlist: ["sub-1"] });
    const res = await client.callTool(del(idIn("sub-2", "rg-ok")));
    expect(text(res)).toMatch(/allowlist/);
    expect(calls).toEqual([]);
  });

  it("delete_resource: refuses a bare resource-group id (use delete_resource_group, which has the typed prompt)", async () => {
    const calls = stubFetch();
    const client = await connect({});
    const res = await client.callTool(del("/subscriptions/sub-1/resourceGroups/rg-ok"));
    expect(text(res)).toMatch(/single resource/);
    expect(calls).toEqual([]);
  });

  it("comparison is case-insensitive: ARM names are, so RG-PROD must not slip past protected 'rg-prod'", async () => {
    const calls = stubFetch();
    const client = await connect({ protectedResourceGroups: ["rg-prod"], resourceGroupAllowlist: ["rg-prod", "rg-dev"] });
    const res = await client.callTool(del(idIn("sub-1", "RG-PROD")));
    expect(text(res)).toMatch(/protected/);
    const grp = await client.callTool({ name: "delete_resource_group", arguments: { name: "RG-Prod", confirm: "RG-Prod" } });
    expect(text(grp)).toMatch(/protected/);
    expect(calls).toEqual([]);
  });

  it("a matching (even differently-cased) resourceGroup argument is accepted and the call proceeds", async () => {
    const calls = stubFetch();
    const client = await connect({ resourceGroupAllowlist: ["rg-ok"] });
    const res = await client.callTool({
      name: "tag_resource",
      arguments: { resourceId: idIn("sub-1", "RG-OK"), resourceGroup: "rg-ok", subscription: "SUB-1", tags: { a: "b" } },
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(calls.some((c) => c.method === "PATCH" && c.host === "management.azure.com" && new URL(c.url).pathname.startsWith("/subscriptions/sub-1/"))).toBe(true);
  });

  it("delete_resource_group / list_resources: traversal in a name cannot reach another group or subscription", async () => {
    const calls = stubFetch();
    const client = await connect({ protectedResourceGroups: ["rg-prod"] });
    const a = await client.callTool({ name: "delete_resource_group", arguments: { name: "x/../rg-prod", confirm: "x/../rg-prod" } });
    expect((a as { isError?: boolean }).isError).toBe(true);
    const b = await client.callTool({ name: "list_resources", arguments: { resourceGroup: "../../sub-2/resourceGroups/prod" } });
    expect((b as { isError?: boolean }).isError).toBe(true);
    const c = await client.callTool({ name: "control_vm", arguments: { resourceGroup: "rg-ok", vmName: "../../x", action: "powerOff" } });
    expect((c as { isError?: boolean }).isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
