import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureClient } from "../src/azure/client.js";

const client = () => new AzureClient({ tenantId: "t", clientId: "c", clientSecret: "s", requestTimeout: 1000 });
const json = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });

/** Stub fetch: the token endpoint plus a route table keyed by "METHOD path-suffix". */
function stubArm(routes: Record<string, () => ReturnType<typeof json>>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: { method?: string }) => {
    const url = new URL(String(input));
    if (url.host === "login.microsoftonline.com") return json(200, { access_token: "tok", expires_in: 3600 });
    calls.push(`${url.host}${url.pathname}`);
    const key = Object.keys(routes).find((k) => url.pathname.endsWith(k) && (init?.method ?? "GET") === "GET");
    if (!key) return json(404, { error: { code: "NotFound" } });
    return routes[key]!();
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("resourceGroupVersion", () => {
  const rg = { id: "/subscriptions/s/resourceGroups/rg", location: "eastus", tags: { a: "1" }, properties: { provisioningState: "Succeeded" } };
  const list = (value: unknown[], nextLink?: string) => () => json(200, { value, nextLink });

  it("is stable for identical contents regardless of listing order", async () => {
    stubArm({ "/resourcegroups/rg": () => json(200, rg), "/resources": list([{ id: "/x/1", createdTime: "t1" }, { id: "/x/2", createdTime: "t2" }]) });
    const a = await client().resourceGroupVersion("s", "rg");
    stubArm({ "/resourcegroups/rg": () => json(200, rg), "/resources": list([{ id: "/x/2", createdTime: "t2" }, { id: "/x/1", createdTime: "t1" }]) });
    expect(await client().resourceGroupVersion("s", "rg")).toBe(a);
  });

  it("changes when a resource is added or recreated", async () => {
    stubArm({ "/resourcegroups/rg": () => json(200, rg), "/resources": list([{ id: "/x/1", createdTime: "t1" }]) });
    const base = await client().resourceGroupVersion("s", "rg");
    stubArm({ "/resourcegroups/rg": () => json(200, rg), "/resources": list([{ id: "/x/1", createdTime: "t1" }, { id: "/x/2", createdTime: "t2" }]) });
    expect(await client().resourceGroupVersion("s", "rg")).not.toBe(base);
    stubArm({ "/resourcegroups/rg": () => json(200, rg), "/resources": list([{ id: "/x/1", createdTime: "t9" }]) });
    expect(await client().resourceGroupVersion("s", "rg")).not.toBe(base);
  });

  it("returns undefined when the group does not exist", async () => {
    stubArm({});
    expect(await client().resourceGroupVersion("s", "gone")).toBeUndefined();
  });

  it("follows nextLink within ARM and refuses to follow it off ARM", async () => {
    const calls = stubArm({
      "/resourcegroups/rg": () => json(200, rg),
      "/resources": (() => {
        let n = 0;
        return () => json(200, n++ === 0 ? { value: [{ id: "/x/1" }], nextLink: "https://management.azure.com/page2/resources" } : { value: [{ id: "/x/2" }] });
      })(),
      "/page2/resources": list([{ id: "/x/2" }]),
    });
    await client().resourceGroupVersion("s", "rg");
    expect(calls).toContain("management.azure.com/page2/resources");

    stubArm({
      "/resourcegroups/rg": () => json(200, rg),
      "/resources": list([{ id: "/x/1" }], "https://evil.example.com/steal"),
    });
    await expect(client().resourceGroupVersion("s", "rg")).rejects.toThrow(/outside/);
  });
});

describe("resourceVersion", () => {
  const id = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/a";

  it("uses id + etag when the resource returns one (other fields are ignored)", async () => {
    stubArm({ "/storageAccounts/a": () => json(200, { id, etag: "W/1", properties: { x: 1 } }) });
    const a = await client().resourceVersion(id, "2023-01-01");
    stubArm({ "/storageAccounts/a": () => json(200, { id, etag: "W/1", properties: { x: 2 } }) });
    expect(await client().resourceVersion(id, "2023-01-01")).toBe(a);
    stubArm({ "/storageAccounts/a": () => json(200, { id, etag: "W/2", properties: { x: 1 } }) });
    expect(await client().resourceVersion(id, "2023-01-01")).not.toBe(a);
  });

  it("without an etag, hashes the body but ignores provisioningState", async () => {
    stubArm({ "/storageAccounts/a": () => json(200, { id, properties: { sku: "A", provisioningState: "Updating" } }) });
    const a = await client().resourceVersion(id, "2023-01-01");
    stubArm({ "/storageAccounts/a": () => json(200, { id, properties: { sku: "A", provisioningState: "Succeeded" } }) });
    expect(await client().resourceVersion(id, "2023-01-01")).toBe(a);
    stubArm({ "/storageAccounts/a": () => json(200, { id, properties: { sku: "B", provisioningState: "Succeeded" } }) });
    expect(await client().resourceVersion(id, "2023-01-01")).not.toBe(a);
  });

  it("returns undefined on 404 and throws on other errors", async () => {
    stubArm({});
    expect(await client().resourceVersion(id, "2023-01-01")).toBeUndefined();
    stubArm({ "/storageAccounts/a": () => json(500, {}) });
    await expect(client().resourceVersion(id, "2023-01-01")).rejects.toThrow();
  });
});

describe("vmVersion", () => {
  const vm = (vmId: string, state: string) => ({
    id: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/web1",
    properties: { vmId, provisioningState: state, hardwareProfile: { vmSize: "Standard_D2s_v3" }, storageProfile: { osDisk: { managedDisk: { id: "/disk/1" } } } },
  });

  it("is unchanged by provisioning state but changes when the VM is recreated (new vmId)", async () => {
    stubArm({ "/virtualMachines/web1": () => json(200, vm("uuid-1", "Succeeded")) });
    const a = await client().vmVersion("s", "rg", "web1");
    stubArm({ "/virtualMachines/web1": () => json(200, vm("uuid-1", "Updating")) });
    expect(await client().vmVersion("s", "rg", "web1")).toBe(a);
    stubArm({ "/virtualMachines/web1": () => json(200, vm("uuid-2", "Succeeded")) });
    expect(await client().vmVersion("s", "rg", "web1")).not.toBe(a);
  });
});
