import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AppConfig } from "../src/config.js";
import type { SecurityConfig } from "../src/security.js";
import { buildServer } from "../src/server.js";

const baseSecurity: SecurityConfig = {
  mode: "read-only",
  subscriptionAllowlist: [],
  resourceGroupAllowlist: [],
  protectedResourceGroups: [],
  locationAllowlist: [],
  allowDelete: false,
  requireConfirmation: true,
  dryRun: false,
  auditLog: false,
  requireHumanApproval: false,
};

async function connect(security: Partial<SecurityConfig> = {}) {
  const config: AppConfig = {
    connection: { tenantId: "t", clientId: "c", clientSecret: "s", defaultSubscription: "sub-1", requestTimeout: 1000 },
    security: { ...baseSecurity, ...security },
  };
  const { server } = buildServer(config);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const json = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });

const ARM = "https://management.azure.com";
const storage = (rg: string, name: string) => ({
  id: `/subscriptions/sub-1/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${name}`,
  name,
  type: "Microsoft.Storage/storageAccounts",
  location: "eastus",
});

/**
 * A fake paged ARM. `pages` maps a request path to its pages; page N's nextLink is the same path with
 * `$skiptoken=N+1` (the shape ARM uses). Records every ARM request URL it serves.
 */
function fakeArm(pages: Record<string, unknown[][]>, opts: { nextLinkFor?: (path: string, n: number) => string | undefined } = {}) {
  const requests: string[] = [];
  const hosts = new Set<string>();
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = new URL(String(input));
    hosts.add(url.host);
    if (url.host === "login.microsoftonline.com") return json(200, { access_token: "tok", expires_in: 3600 });
    requests.push(url.toString());
    const set = Object.entries(pages).find(([p]) => url.pathname.toLowerCase() === p.toLowerCase())?.[1];
    if (!set) return json(404, { error: { code: "NotFound" } });
    const n = Number(url.searchParams.get("$skiptoken") ?? 0);
    const more = n + 1 < set.length;
    const defaultLink = more ? `${ARM}${url.pathname}?api-version=2021-04-01&$skiptoken=${n + 1}` : undefined;
    const nextLink = opts.nextLinkFor ? opts.nextLinkFor(url.pathname, n) : defaultLink;
    return json(200, { value: set[n] ?? [], ...(nextLink ? { nextLink } : {}) });
  });
  return { requests, hosts };
}

afterEach(() => vi.unstubAllGlobals());

describe("list_resources follows nextLink", () => {
  const PATH = "/subscriptions/sub-1/resources";

  it("returns every page of a large subscription (not just the first)", async () => {
    const { requests } = fakeArm({
      [PATH]: [[storage("rg-a", "p1a"), storage("rg-a", "p1b")], [storage("rg-a", "p2a")], [storage("rg-a", "p3a"), storage("rg-a", "p3b")]],
    });
    const client = await connect();
    const out = await client.callTool({ name: "list_resources", arguments: {} });
    expect(isError(out)).toBe(false);
    const names = (JSON.parse(text(out)) as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(["p1a", "p1b", "p2a", "p3a", "p3b"]);
    expect(requests).toHaveLength(3);
  });

  it("finds an allowlisted group's resource that is only on a later page (the allowlist must not under-report)", async () => {
    fakeArm({ [PATH]: [[storage("rg-other", "x1")], [storage("rg-other", "x2")], [storage("rg-ok", "wanted")]] });
    const client = await connect({ resourceGroupAllowlist: ["rg-ok"] });
    const out = await client.callTool({ name: "list_resources", arguments: {} });
    expect((JSON.parse(text(out)) as Array<{ name: string }>).map((r) => r.name)).toEqual(["wanted"]);
  });

  it("pages a group-scoped listing too", async () => {
    fakeArm({ "/subscriptions/sub-1/resourceGroups/rg-ok/resources": [[storage("rg-ok", "a")], [storage("rg-ok", "b")]] });
    const client = await connect({ resourceGroupAllowlist: ["rg-ok"] });
    const out = await client.callTool({ name: "list_resources", arguments: { resourceGroup: "rg-ok" } });
    expect((JSON.parse(text(out)) as Array<{ name: string }>).map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("says so explicitly when the page cap is hit, and still returns what it read", async () => {
    // An endless listing: every page has a nextLink. The helper must stop at its cap, not loop.
    const { requests } = fakeArm({ [PATH]: Array.from({ length: 500 }, (_, i) => [storage("rg-a", `r${i}`)]) });
    const client = await connect();
    const out = await client.callTool({ name: "list_resources", arguments: {} });
    expect(isError(out)).toBe(false);
    const body = JSON.parse(text(out)) as { truncated: boolean; note: string; items: Array<{ name: string }> };
    expect(body.truncated).toBe(true);
    expect(body.note).toMatch(/incomplete|truncated|page/i);
    expect(body.items.length).toBe(requests.length);
    expect(body.items.length).toBeGreaterThan(1);
    expect(requests.length).toBeLessThan(500);
  });

  it("a complete listing is a plain array with no truncation marker", async () => {
    fakeArm({ [PATH]: [[storage("rg-a", "a")], [storage("rg-a", "b")]] });
    const client = await connect();
    const body = JSON.parse(text(await client.callTool({ name: "list_resources", arguments: {} })));
    expect(Array.isArray(body)).toBe(true);
    expect(text(await client.callTool({ name: "list_resources", arguments: {} }))).not.toContain("truncated");
  });

  it("with an allowlist, a truncated listing says the filtered result may be incomplete", async () => {
    fakeArm({ [PATH]: Array.from({ length: 500 }, (_, i) => [storage(i === 0 ? "rg-ok" : "rg-other", `r${i}`)]) });
    const client = await connect({ resourceGroupAllowlist: ["rg-ok"] });
    const body = JSON.parse(text(await client.callTool({ name: "list_resources", arguments: {} }))) as { truncated: boolean; items: unknown[] };
    expect(body.truncated).toBe(true);
    expect(body.items).toHaveLength(1);
  });

  it("refuses a nextLink that leaves ARM: the attacker host is never contacted and the token never sent there", async () => {
    const { hosts } = fakeArm(
      { [PATH]: [[storage("rg-a", "a")], [storage("rg-a", "b")]] },
      { nextLinkFor: () => "https://attacker.example/steal?$skiptoken=1" },
    );
    const client = await connect();
    const out = await client.callTool({ name: "list_resources", arguments: {} });
    expect(isError(out)).toBe(true);
    expect(hosts.has("attacker.example")).toBe(false);
  });
});

describe("other paged list tools follow nextLink", () => {
  it("list_resource_groups finds an allowlisted group on a later page", async () => {
    fakeArm({
      "/subscriptions/sub-1/resourcegroups": [
        [{ name: "rg-x", location: "eastus" }],
        [{ name: "rg-ok", location: "eastus" }, { name: "rg-prod", location: "eastus" }],
      ],
    });
    const client = await connect({ resourceGroupAllowlist: ["rg-ok", "rg-prod"], protectedResourceGroups: ["rg-prod"] });
    const out = JSON.parse(text(await client.callTool({ name: "list_resource_groups", arguments: {} }))) as Array<{ name: string; protected: boolean }>;
    expect(out.map((g) => [g.name, g.protected])).toEqual([["rg-ok", false], ["rg-prod", true]]);
  });

  it("list_subscriptions finds an allowlisted subscription on a later page", async () => {
    fakeArm({
      "/subscriptions": [
        [{ subscriptionId: "sub-9", displayName: "other", state: "Enabled" }],
        [{ subscriptionId: "sub-1", displayName: "mine", state: "Enabled" }],
      ],
    });
    const client = await connect({ subscriptionAllowlist: ["sub-1"] });
    const out = JSON.parse(text(await client.callTool({ name: "list_subscriptions", arguments: {} }))) as Array<{ subscriptionId: string }>;
    expect(out.map((s) => s.subscriptionId)).toEqual(["sub-1"]);
  });

  it("list_resource_groups and list_subscriptions report truncation explicitly", async () => {
    fakeArm({
      "/subscriptions/sub-1/resourcegroups": Array.from({ length: 500 }, (_, i) => [{ name: `rg-${i}`, location: "eastus" }]),
      "/subscriptions": Array.from({ length: 500 }, (_, i) => [{ subscriptionId: `s-${i}`, displayName: "d", state: "Enabled" }]),
    });
    const client = await connect();
    for (const name of ["list_resource_groups", "list_subscriptions"]) {
      const body = JSON.parse(text(await client.callTool({ name, arguments: {} }))) as { truncated: boolean; items: unknown[] };
      expect(body.truncated, name).toBe(true);
      expect(body.items.length, name).toBeGreaterThan(1);
    }
  });
});
