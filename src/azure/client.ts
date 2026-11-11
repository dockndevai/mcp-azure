/**
 * Thin fetch-based client for the Azure Resource Manager (ARM) REST API.
 * Auth is OAuth2 client credentials against Entra ID; tokens are cached.
 * https://learn.microsoft.com/rest/api/resources/
 */
import { createHash } from "node:crypto";
import type { AzureConnection } from "../config.js";

const ARM = "https://management.azure.com";

export class AzureError extends Error {
  constructor(message: string, readonly status: number, readonly body?: string) {
    super(message);
    this.name = "AzureError";
  }
}

/** Deterministic JSON (sorted keys) so equal content always hashes equally. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 12);
}

/** Drop `provisioningState` (it flips while an operation runs) at any depth; everything else is content. */
function withoutProvisioningState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutProvisioningState);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.toLowerCase() === "provisioningstate") continue;
    out[k] = withoutProvisioningState(v);
  }
  return out;
}

/** Bounds the nextLink walk when fingerprinting a resource group (50 pages of resources). */
const MAX_PAGES = 50;

interface Token {
  accessToken: string;
  expiresAt: number;
}

export class AzureClient {
  private token?: Token;

  constructor(private readonly conn: AzureConnection) {}

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.accessToken;
    const url = `https://login.microsoftonline.com/${this.conn.tenantId}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.conn.clientId,
      client_secret: this.conn.clientSecret,
      scope: `${ARM}/.default`,
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AzureError(`Azure AD token request failed (${res.status}). Check tenant/client/secret.`, res.status, body);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in - 30) * 1000 };
    return this.token.accessToken;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { apiVersion: string; query?: Record<string, string | undefined>; body?: unknown } = { apiVersion: "2021-04-01" },
  ): Promise<T> {
    const token = await this.getToken();
    const url = new URL(path.startsWith("http") ? path : `${ARM}${path}`);
    url.searchParams.set("api-version", opts.apiVersion);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.conn.requestTimeout);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new AzureError(`Azure ARM ${method} ${path} failed with ${res.status}.`, res.status, text);
      return (text ? JSON.parse(text) : undefined) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Follow `nextLink` paging, refusing any link that leaves ARM (the bearer token must not follow it). */
  private async listAll<T>(
    path: string,
    opts: { apiVersion: string; query?: Record<string, string | undefined> },
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let next: string | undefined = path;
    let first = true;
    for (let page = 0; next && page < MAX_PAGES; page++) {
      if (!first && !next.startsWith(`${ARM}/`)) throw new AzureError(`Refusing to follow a nextLink outside ${ARM}.`, 0);
      const res: { value?: T[]; nextLink?: string } = await this.request("GET", next, first ? opts : { apiVersion: opts.apiVersion });
      items.push(...(res?.value ?? []));
      next = res?.nextLink;
      first = false;
    }
    return { items, truncated: next !== undefined };
  }

  private async getOrUndefined<T>(path: string, apiVersion: string): Promise<T | undefined> {
    try {
      return await this.request<T>("GET", path, { apiVersion });
    } catch (err) {
      if (err instanceof AzureError && err.status === 404) return undefined;
      throw err;
    }
  }

  // --- Version tokens (pinned across a human-approval prompt) ----------------
  /**
   * Resource groups carry no etag, so the token is a hash of the group's id, location and tags plus the
   * (id, createdTime) of every resource inside it: a delete that was approved for one set of contents is
   * refused if a resource was added, removed or recreated while the human was deciding. NOT detected:
   * in-place changes to a contained resource's configuration, and a contained resource recreated with
   * the same id within the same createdTime second.
   */
  async resourceGroupVersion(sub: string, name: string): Promise<string | undefined> {
    const rg = await this.getOrUndefined<{ id?: string; location?: string; tags?: Record<string, string> }>(
      `/subscriptions/${sub}/resourcegroups/${name}`,
      "2021-04-01",
    );
    if (!rg) return undefined;
    const { items, truncated } = await this.listAll<{ id?: string; createdTime?: string }>(
      `/subscriptions/${sub}/resourceGroups/${name}/resources`,
      { apiVersion: "2021-04-01", query: { $expand: "createdTime" } },
    );
    const members = items.map((r) => `${r.id ?? ""}@${r.createdTime ?? ""}`).sort();
    return digest({ id: rg.id, location: rg.location, tags: rg.tags ?? {}, members, truncated });
  }

  /**
   * Single resource: its id plus the ARM `etag` when the resource type returns one; otherwise a hash of the
   * resource body without `provisioningState`. NOT detected: an etag-less resource whose change is confined to
   * fields the GET does not return, or a same-id recreate with identical properties.
   */
  async resourceVersion(resourceId: string, apiVersion: string): Promise<string | undefined> {
    const r = await this.getOrUndefined<Record<string, unknown>>(resourceId, apiVersion);
    if (!r) return undefined;
    if (typeof r.etag === "string" && r.etag) return digest({ id: r.id ?? resourceId, etag: r.etag });
    return digest({ id: r.id ?? resourceId, body: withoutProvisioningState(r) });
  }

  /**
   * VM: its id, the platform-assigned `vmId` (a delete + recreate under the same name gets a new vmId), size and
   * OS-disk id. Deliberately excludes power state, tags and provisioningState, which change without the VM being
   * a different VM. NOT detected: changes to data disks or NICs.
   */
  async vmVersion(sub: string, rg: string, vm: string): Promise<string | undefined> {
    type Vm = {
      id?: string;
      properties?: {
        vmId?: string;
        hardwareProfile?: { vmSize?: string };
        storageProfile?: { osDisk?: { name?: string; managedDisk?: { id?: string } } };
      };
    };
    const v = await this.getOrUndefined<Vm>(
      `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${vm}`,
      "2023-07-01",
    );
    if (!v) return undefined;
    const p = v.properties ?? {};
    return digest({
      id: v.id,
      vmId: p.vmId,
      size: p.hardwareProfile?.vmSize,
      osDisk: p.storageProfile?.osDisk?.managedDisk?.id ?? p.storageProfile?.osDisk?.name,
    });
  }

  // --- Reads -----------------------------------------------------------------
  listSubscriptions() {
    return this.request("GET", "/subscriptions", { apiVersion: "2022-12-01" });
  }
  listLocations(sub: string) {
    return this.request("GET", `/subscriptions/${sub}/locations`, { apiVersion: "2022-12-01" });
  }
  listResourceGroups(sub: string) {
    return this.request("GET", `/subscriptions/${sub}/resourcegroups`, { apiVersion: "2021-04-01" });
  }
  listResources(sub: string, rg?: string) {
    const path = rg
      ? `/subscriptions/${sub}/resourceGroups/${rg}/resources`
      : `/subscriptions/${sub}/resources`;
    return this.request("GET", path, { apiVersion: "2021-04-01" });
  }
  getResource(resourceId: string, apiVersion: string) {
    return this.request("GET", resourceId, { apiVersion });
  }

  // --- Writes ----------------------------------------------------------------
  createResourceGroup(sub: string, name: string, location: string, tags?: Record<string, string>) {
    return this.request("PUT", `/subscriptions/${sub}/resourcegroups/${name}`, {
      apiVersion: "2021-04-01",
      body: { location, tags },
    });
  }
  /** Merge tags onto any resource via the generic Tags API (no per-type api-version needed). */
  tagResource(resourceId: string, tags: Record<string, string>) {
    return this.request("PATCH", `${resourceId}/providers/Microsoft.Resources/tags/default`, {
      apiVersion: "2021-04-01",
      body: { operation: "Merge", properties: { tags } },
    });
  }
  /** Power action on a VM: start | powerOff | restart | deallocate. */
  controlVm(sub: string, rg: string, vm: string, action: string) {
    return this.request(
      "POST",
      `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${vm}/${action}`,
      { apiVersion: "2023-07-01" },
    );
  }

  // --- Destructive -----------------------------------------------------------
  deleteResourceGroup(sub: string, name: string) {
    return this.request("DELETE", `/subscriptions/${sub}/resourcegroups/${name}`, { apiVersion: "2021-04-01" });
  }
  deleteResource(resourceId: string, apiVersion: string) {
    return this.request("DELETE", resourceId, { apiVersion });
  }
}
