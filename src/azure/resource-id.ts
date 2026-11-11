/**
 * Strict handling of model-supplied ARM identifiers.
 *
 * Everything a tool interpolates into an ARM URL (subscription, resource group, resource name, a whole
 * resource id) is untrusted. A value is only used if every path segment is a plain name: no `/`, `?`, `#`,
 * `\`, `%`, whitespace, control characters, and no `.` / `..` (URL normalisation would otherwise let
 * `rg-ok/../../other-sub/...` walk out of the scope the policy checked). The policy must be evaluated on
 * the subscription / resource group PARSED from the id, never on a separate caller-supplied argument.
 */
import { PolicyError } from "../security.js";

/** One path segment of an ARM id: letters, digits and the punctuation ARM names actually use. */
const SEGMENT = /^[A-Za-z0-9._()~:+=,@-]+$/;
const MAX_ID_LENGTH = 2048;

export function isValidSegment(value: string): boolean {
  return value !== "." && value !== ".." && SEGMENT.test(value);
}

/** Validate a single name (subscription id, resource group, resource, VM) before it goes into a URL path. */
export function assertSegment(value: unknown, what: string): string {
  if (typeof value !== "string" || !isValidSegment(value)) {
    throw new PolicyError(`Invalid ${what}: expected a plain ARM name without '/', '..', '?', '#', '%' or whitespace.`);
  }
  return value;
}

/** Validate a path (starting with `/`) segment by segment; used for every request the client builds. */
export function assertArmPath(path: string): void {
  if (path.length > MAX_ID_LENGTH || !path.startsWith("/")) {
    throw new PolicyError("Invalid ARM path: must be an absolute path starting with '/'.");
  }
  for (const seg of path.slice(1).split("/")) {
    if (!isValidSegment(seg)) throw new PolicyError(`Invalid ARM path segment '${seg.slice(0, 40)}'.`);
  }
}

export interface ResourceScope {
  /** The validated id, exactly as it will be requested. */
  id: string;
  subscription: string;
  /** Absent for subscription-scoped ids (`/subscriptions/{s}` and `/subscriptions/{s}/providers/...`). */
  resourceGroup?: string;
}

/**
 * Parse `/subscriptions/{s}[/resourceGroups/{rg}][/providers/{ns}/{type}/{name}...]`.
 * `requireResource` additionally demands a real resource (`.../providers/{ns}/{type}/{name}`), so a bare
 * subscription or resource-group id cannot be passed where one resource is meant (e.g. DELETE on a group id).
 */
export function parseResourceId(raw: unknown, opts: { requireResource?: boolean } = {}): ResourceScope {
  if (typeof raw !== "string") throw new PolicyError("Invalid ARM resource id: expected a string.");
  assertArmPath(raw);
  const parts = raw.slice(1).split("/");
  if (parts[0]!.toLowerCase() !== "subscriptions" || parts.length < 2) {
    throw new PolicyError("Invalid ARM resource id: must start with /subscriptions/{subscriptionId}.");
  }
  const subscription = parts[1]!;
  let i = 2;
  let resourceGroup: string | undefined;
  if (parts[i]?.toLowerCase() === "resourcegroups") {
    resourceGroup = parts[i + 1];
    if (!resourceGroup) throw new PolicyError("Invalid ARM resource id: missing resource group name.");
    i += 2;
  }
  const rest = parts.slice(i);
  if (rest.length > 0 && (rest[0]!.toLowerCase() !== "providers" || rest.length < 4)) {
    throw new PolicyError("Invalid ARM resource id: expected .../providers/{namespace}/{type}/{name}.");
  }
  if (opts.requireResource && rest.length === 0) {
    throw new PolicyError("Invalid ARM resource id: expected a single resource (.../providers/{namespace}/{type}/{name}).");
  }
  return { id: raw, subscription, ...(resourceGroup !== undefined ? { resourceGroup } : {}) };
}
