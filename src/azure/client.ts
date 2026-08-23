/**
 * Thin fetch-based client for the Azure Resource Manager (ARM) REST API.
 * Auth is OAuth2 client credentials against Entra ID; tokens are cached.
 * https://learn.microsoft.com/rest/api/resources/
 */
import type { AzureConnection } from "../config.js";

const ARM = "https://management.azure.com";

export class AzureError extends Error {
  constructor(message: string, readonly status: number, readonly body?: string) {
    super(message);
    this.name = "AzureError";
  }
}

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
