/**
 * Governance & security policy engine for Azure Resource Manager.
 *
 * Shared model (access modes + capability gating + delete gating + dry-run +
 * audit) plus Azure governance controls:
 *   - Subscription and resource-group allowlists.
 *   - Protected resource groups: readable, never mutated or deleted.
 *   - Location allowlist: new resource groups may only be created in approved regions.
 *   - High-impact confirmation: destructive ops must echo back the exact target name.
 *
 * Pure logic, no I/O — fully unit-testable.
 */

export type Capability = "read" | "write" | "admin";
export type AccessMode = "read-only" | "read-write" | "admin";

const MODE_RANK: Record<AccessMode, number> = { "read-only": 0, "read-write": 1, admin: 2 };
const CAPABILITY_RANK: Record<Capability, number> = { read: 0, write: 1, admin: 2 };

export interface SecurityConfig {
  mode: AccessMode;
  /** If set, only these subscription ids are in scope. Empty = all. */
  subscriptionAllowlist: string[];
  /** If set, only these resource groups may be touched. Empty = all. */
  resourceGroupAllowlist: string[];
  /** Resource groups that can be read but never mutated or deleted. */
  protectedResourceGroups: string[];
  /** If set, resource groups may only be created in these locations. Empty = any. */
  locationAllowlist: string[];
  allowDelete: boolean;
  requireConfirmation: boolean;
  dryRun: boolean;
  auditLog: boolean;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface GuardContext {
  tool: string;
  capability: Capability;
  subscription?: string;
  resourceGroup?: string;
  location?: string;
  destructive?: boolean;
  confirmExpected?: string;
  confirmProvided?: string;
}

export class SecurityPolicy {
  constructor(private readonly config: SecurityConfig) {}

  get mode(): AccessMode {
    return this.config.mode;
  }

  isCapabilityEnabled(capability: Capability): boolean {
    return CAPABILITY_RANK[capability] <= MODE_RANK[this.config.mode];
  }

  isSubscriptionAllowed(sub: string): boolean {
    if (this.config.subscriptionAllowlist.length === 0) return true;
    return this.config.subscriptionAllowlist.includes(sub);
  }

  isResourceGroupAllowed(rg: string): boolean {
    if (this.config.resourceGroupAllowlist.length === 0) return true;
    return this.config.resourceGroupAllowlist.includes(rg);
  }

  isResourceGroupProtected(rg: string): boolean {
    return this.config.protectedResourceGroups.includes(rg);
  }

  isLocationAllowed(loc: string): boolean {
    if (this.config.locationAllowlist.length === 0) return true;
    return this.config.locationAllowlist.includes(loc.toLowerCase().replace(/\s+/g, ""));
  }

  guard(ctx: GuardContext): { dryRun: boolean } {
    if (!this.isCapabilityEnabled(ctx.capability)) {
      this.audit(ctx, "DENY", `capability '${ctx.capability}' exceeds mode '${this.config.mode}'`);
      throw new PolicyError(
        `Operation '${ctx.tool}' requires '${ctx.capability}' access but the server runs in '${this.config.mode}' mode.`,
      );
    }

    if (ctx.subscription !== undefined && !this.isSubscriptionAllowed(ctx.subscription)) {
      this.audit(ctx, "DENY", `subscription '${ctx.subscription}' not in allowlist`);
      throw new PolicyError(
        `Subscription '${ctx.subscription}' is not in the configured allowlist (AZURE_SUBSCRIPTION_ALLOWLIST).`,
      );
    }

    if (ctx.resourceGroup !== undefined) {
      if (!this.isResourceGroupAllowed(ctx.resourceGroup)) {
        this.audit(ctx, "DENY", `resource group '${ctx.resourceGroup}' not in allowlist`);
        throw new PolicyError(
          `Resource group '${ctx.resourceGroup}' is not in the configured allowlist (AZURE_RESOURCE_GROUP_ALLOWLIST).`,
        );
      }
      if (ctx.capability !== "read" && this.isResourceGroupProtected(ctx.resourceGroup)) {
        this.audit(ctx, "DENY", `resource group '${ctx.resourceGroup}' is protected`);
        throw new PolicyError(
          `Resource group '${ctx.resourceGroup}' is protected (AZURE_PROTECTED_RESOURCE_GROUPS); mutations are refused.`,
        );
      }
    }

    if (ctx.location !== undefined && !this.isLocationAllowed(ctx.location)) {
      this.audit(ctx, "DENY", `location '${ctx.location}' not in allowlist`);
      throw new PolicyError(
        `Location '${ctx.location}' is not in the configured allowlist (AZURE_LOCATION_ALLOWLIST).`,
      );
    }

    if (ctx.destructive && !this.config.allowDelete) {
      this.audit(ctx, "DENY", "delete not enabled");
      throw new PolicyError(
        `Destructive operation '${ctx.tool}' is disabled. Set AZURE_ALLOW_DELETE=true to enable it.`,
      );
    }

    if (ctx.destructive && this.config.requireConfirmation && ctx.confirmExpected !== undefined) {
      if (ctx.confirmProvided !== ctx.confirmExpected) {
        this.audit(ctx, "DENY", "confirmation mismatch");
        throw new PolicyError(
          `Operation '${ctx.tool}' is high-impact. Re-run with confirm="${ctx.confirmExpected}" to proceed.`,
        );
      }
    }

    const dryRun = ctx.capability !== "read" && this.config.dryRun;
    this.audit(ctx, dryRun ? "DRY_RUN" : "ALLOW");
    return { dryRun };
  }

  private audit(ctx: GuardContext, decision: string, reason?: string): void {
    if (!this.config.auditLog) return;
    const line = {
      ts: new Date().toISOString(),
      audit: "azure-mcp",
      decision,
      tool: ctx.tool,
      capability: ctx.capability,
      subscription: ctx.subscription ?? null,
      resourceGroup: ctx.resourceGroup ?? null,
      destructive: ctx.destructive ?? false,
      ...(reason ? { reason } : {}),
    };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  }
}
