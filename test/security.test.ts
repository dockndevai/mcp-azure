import { describe, expect, it } from "vitest";
import { PolicyError, SecurityPolicy, type SecurityConfig } from "../src/security.js";

function makePolicy(overrides: Partial<SecurityConfig> = {}): SecurityPolicy {
  return new SecurityPolicy({
    mode: "read-only",
    subscriptionAllowlist: [],
    resourceGroupAllowlist: [],
    protectedResourceGroups: [],
    locationAllowlist: [],
    allowDelete: false,
    requireConfirmation: true,
    dryRun: false,
    auditLog: false,
    ...overrides,
  });
}

describe("capability gating", () => {
  it("read-only enables read only", () => {
    const p = makePolicy();
    expect(p.isCapabilityEnabled("read")).toBe(true);
    expect(p.isCapabilityEnabled("write")).toBe(false);
    expect(p.isCapabilityEnabled("admin")).toBe(false);
  });
});

describe("subscription + resource group scoping", () => {
  it("blocks subscriptions outside the allowlist", () => {
    const p = makePolicy({ subscriptionAllowlist: ["sub-a"] });
    expect(() => p.guard({ tool: "list_resources", capability: "read", subscription: "sub-b" })).toThrow(/allowlist/);
  });
  it("blocks resource groups outside the allowlist", () => {
    const p = makePolicy({ mode: "read-write", resourceGroupAllowlist: ["rg-app"] });
    expect(() => p.guard({ tool: "tag_resource", capability: "write", resourceGroup: "rg-secret" })).toThrow(/allowlist/);
  });
  it("allows reading a protected RG but not mutating it", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true, protectedResourceGroups: ["rg-prod"] });
    expect(() => p.guard({ tool: "list_resources", capability: "read", resourceGroup: "rg-prod" })).not.toThrow();
    expect(() => p.guard({ tool: "tag_resource", capability: "write", resourceGroup: "rg-prod" })).toThrow(/protected/);
  });
});

describe("location allowlist", () => {
  it("blocks creating in a non-approved region", () => {
    const p = makePolicy({ mode: "read-write", locationAllowlist: ["eastus"] });
    expect(() => p.guard({ tool: "create_resource_group", capability: "write", resourceGroup: "rg", location: "West Europe" })).toThrow(/allowlist/);
    expect(() => p.guard({ tool: "create_resource_group", capability: "write", resourceGroup: "rg", location: "eastus" })).not.toThrow();
  });
});

describe("destructive gating + confirmation", () => {
  it("blocks delete without allowDelete", () => {
    const p = makePolicy({ mode: "admin" });
    expect(() =>
      p.guard({ tool: "delete_resource_group", capability: "admin", resourceGroup: "rg", destructive: true, confirmExpected: "rg", confirmProvided: "rg" }),
    ).toThrow(/ALLOW_DELETE/);
  });
  it("refuses on confirmation mismatch", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true });
    expect(() =>
      p.guard({ tool: "delete_resource_group", capability: "admin", resourceGroup: "rg-prod", destructive: true, confirmExpected: "rg-prod", confirmProvided: "rg" }),
    ).toThrow(/confirm="rg-prod"/);
  });
  it("proceeds on match", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true });
    expect(() =>
      p.guard({ tool: "delete_resource_group", capability: "admin", resourceGroup: "rg-prod", destructive: true, confirmExpected: "rg-prod", confirmProvided: "rg-prod" }),
    ).not.toThrow();
  });
});

describe("dry run", () => {
  it("flags writes but not reads", () => {
    const p = makePolicy({ mode: "read-write", dryRun: true });
    expect(p.guard({ tool: "list_resources", capability: "read", subscription: "s" }).dryRun).toBe(false);
    expect(p.guard({ tool: "create_resource_group", capability: "write", resourceGroup: "rg" }).dryRun).toBe(true);
  });
});
