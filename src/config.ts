import type { AccessMode, SecurityConfig } from "./security.js";

export interface AzureConnection {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Default subscription id used when a tool omits one. */
  defaultSubscription?: string;
  requestTimeout: number;
}

export interface AppConfig {
  connection: AzureConnection;
  security: SecurityConfig;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function list(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseMode(): AccessMode {
  const raw = (process.env.AZURE_MODE ?? "read-only").toLowerCase();
  if (raw === "read-only" || raw === "read-write" || raw === "admin") return raw;
  throw new Error(`Invalid AZURE_MODE '${raw}'. Expected one of: read-only, read-write, admin.`);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export function loadConfig(): AppConfig {
  return {
    connection: {
      tenantId: required("AZURE_TENANT_ID"),
      clientId: required("AZURE_CLIENT_ID"),
      clientSecret: required("AZURE_CLIENT_SECRET"),
      defaultSubscription: process.env.AZURE_SUBSCRIPTION_ID || undefined,
      requestTimeout: Number(process.env.AZURE_TIMEOUT_MS ?? 30000),
    },
    security: {
      mode: parseMode(),
      subscriptionAllowlist: list("AZURE_SUBSCRIPTION_ALLOWLIST"),
      resourceGroupAllowlist: list("AZURE_RESOURCE_GROUP_ALLOWLIST"),
      protectedResourceGroups: list("AZURE_PROTECTED_RESOURCE_GROUPS"),
      locationAllowlist: list("AZURE_LOCATION_ALLOWLIST").map((l) => l.toLowerCase().replace(/\s+/g, "")),
      allowDelete: bool("AZURE_ALLOW_DELETE", false),
      requireConfirmation: bool("AZURE_REQUIRE_CONFIRMATION", true),
      dryRun: bool("AZURE_DRY_RUN", false),
      auditLog: bool("AZURE_AUDIT_LOG", true),
    },
  };
}
