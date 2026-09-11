/**
 * validate.ts — connector-side state-doc validation (plan §6, defense in
 * depth): the connector re-validates every pulled doc against the SAME
 * denylist/allowlist/caps the engine enforces — a compromised engine must
 * not be able to weaken a customer's security posture through us (D-8). A
 * doc that fails validation is REJECTED WHOLE and last-good kept, never
 * partially applied (plan §5.2).
 *
 * Constants mirror src/bridge/adapters/nodeapp.ts on the engine side —
 * deliberately duplicated, not imported: this package ships to npm with zero
 * runtime dependencies and no engine coupling.
 */

/** The doc-shape version this connector understands. An unknown version is refused BY NAME and last-good kept — never misread (plan §5.2). */
export const SUPPORTED_STATE_SCHEMA_VERSION = 1;

export interface RedirectRule {
  readonly from: string;
  readonly to: string;
  readonly statusCode?: number;
}

export interface NodeBridgeStateDoc {
  readonly robots?: string;
  readonly rootFiles?: Record<string, string>;
  readonly redirects?: readonly RedirectRule[];
  readonly headerRules?: Record<string, Record<string, string | null>>;
  /** Managed slot values keyed `<opType>/<name>` — meta objects, schema JSON-LD objects, content strings (slice 2). */
  readonly slots?: Record<string, unknown>;
  /** Auto-head entries keyed by query-stripped path (auto-head slice A1): {title?, description?, canonical?, jsonLd?}. */
  readonly heads?: Record<string, Record<string, unknown>>;
}

const HEADER_DENYLIST = new Set([
  'set-cookie',
  'authorization',
  'www-authenticate',
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'x-frame-options',
  'x-content-type-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'referrer-policy',
  'permissions-policy',
  'host',
  'transfer-encoding',
  'content-length',
  'connection',
]);
const HEADER_DENYLIST_PREFIXES = ['proxy-', 'access-control-', 'sec-'] as const;

export function isDeniedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (HEADER_DENYLIST.has(lower)) return true;
  return HEADER_DENYLIST_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

const ROOT_FILE_EXACT_ALLOWLIST = new Set(['llms.txt', 'llms-full.txt', 'ai.txt', 'security.txt']);

export function isAllowedRootFilePath(path: string): boolean {
  if (ROOT_FILE_EXACT_ALLOWLIST.has(path)) return true;
  if (!path.startsWith('.well-known/')) return false;
  const rest = path.slice('.well-known/'.length);
  return /^[A-Za-z0-9._-]{1,128}$/.test(rest) && !rest.includes('..');
}

const MAX_DOC_BYTES = 512 * 1024;
const MAX_FILE_CONTENT_BYTES = 128 * 1024;
const MAX_ROOT_FILES = 32;
const MAX_REDIRECT_RULES = 500;
const MAX_HEADER_PATHS = 200;
const MAX_HEADERS_PER_PATH = 20;
const CONTROL_PATH_PREFIX = '/__signalto';
const MAX_SLOTS = 200;
const MAX_SLOT_CONTENT_BYTES = 128 * 1024;
const MAX_SLOT_SCHEMA_BYTES = 32 * 1024;
const MAX_SLOT_META_FIELD_BYTES = 2 * 1024;
const SLOT_KEY_RE = /^(meta|schema|content)\/[A-Za-z0-9._-]{1,128}$/;
const SLOT_META_FIELDS = new Set(['title', 'description', 'canonical', 'robots', 'ogTitle', 'ogDescription', 'ogImage']);
const MAX_HEADS = 200;
const MAX_HEAD_TEXT_BYTES = 2 * 1024;
const MAX_HEAD_JSONLD_BYTES = 32 * 1024;
const HEAD_FIELDS = new Set(['title', 'description', 'canonical', 'jsonLd']);

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/**
 * A redirect target we are willing to put in a Location header: a same-origin
 * absolute path, or an absolute https URL. `//host/path` is deliberately
 * excluded — it starts with '/' but sends the visitor off-origin.
 */
export function isAllowedRedirectTarget(to: string): boolean {
  if (to.startsWith('//')) return false;
  if (to.startsWith('/')) return true;
  if (!/^https:\/\//i.test(to)) return false;
  try {
    return new URL(to).protocol === 'https:';
  } catch {
    return false;
  }
}

export type ValidationResult =
  | { readonly ok: true; readonly doc: NodeBridgeStateDoc }
  | { readonly ok: false; readonly reason: string };

/**
 * Validates a pulled state payload. Copies every accepted field onto
 * null-prototype objects (prototype-pollution hygiene) — the returned doc
 * shares no object identity with the parsed JSON.
 */
export function validateStateDoc(rawJson: string, schemaVersion: number): ValidationResult {
  if (schemaVersion !== SUPPORTED_STATE_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported_schema_version:${schemaVersion}` };
  }
  if (byteLength(rawJson) > MAX_DOC_BYTES) {
    return { ok: false, reason: 'doc_size_cap_exceeded' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'doc_not_object' };
  }
  const input = parsed as Record<string, unknown>;
  const doc: {
    robots?: string;
    rootFiles?: Record<string, string>;
    redirects?: RedirectRule[];
    headerRules?: Record<string, Record<string, string | null>>;
    slots?: Record<string, unknown>;
    heads?: Record<string, Record<string, unknown>>;
  } = Object.create(null);

  if (input.robots !== undefined) {
    if (typeof input.robots !== 'string' || byteLength(input.robots) > MAX_FILE_CONTENT_BYTES) {
      return { ok: false, reason: 'invalid_robots' };
    }
    doc.robots = input.robots;
  }

  if (input.rootFiles !== undefined) {
    if (typeof input.rootFiles !== 'object' || input.rootFiles === null || Array.isArray(input.rootFiles)) {
      return { ok: false, reason: 'invalid_root_files' };
    }
    const entries = Object.entries(input.rootFiles as Record<string, unknown>);
    if (entries.length > MAX_ROOT_FILES) return { ok: false, reason: 'root_files_cap_exceeded' };
    const rootFiles: Record<string, string> = Object.create(null);
    for (const [path, content] of entries) {
      if (!isAllowedRootFilePath(path)) return { ok: false, reason: `root_file_path_not_allowlisted:${path}` };
      if (typeof content !== 'string' || byteLength(content) > MAX_FILE_CONTENT_BYTES) {
        return { ok: false, reason: `invalid_root_file_content:${path}` };
      }
      rootFiles[path] = content;
    }
    doc.rootFiles = rootFiles;
  }

  if (input.redirects !== undefined) {
    if (!Array.isArray(input.redirects) || input.redirects.length > MAX_REDIRECT_RULES) {
      return { ok: false, reason: 'invalid_redirects' };
    }
    const redirects: RedirectRule[] = [];
    for (const raw of input.redirects as unknown[]) {
      const rule = raw as Partial<RedirectRule> | null;
      if (typeof rule?.from !== 'string' || !rule.from.startsWith('/') || rule.from.startsWith(CONTROL_PATH_PREFIX)) {
        return { ok: false, reason: 'invalid_redirect_from' };
      }
      if (typeof rule.to !== 'string' || rule.to.length === 0) {
        return { ok: false, reason: 'invalid_redirect_to' };
      }
      // The target is written straight into a Location header, so a CR or LF
      // in it is response splitting: everything after the break becomes
      // headers (or a body) of the attacker's choosing.
      if (/[\r\n]/.test(rule.to)) {
        return { ok: false, reason: 'redirect_to_crlf' };
      }
      // Allowlist, not denylist: a same-origin path, or an absolute https
      // URL. That refuses `javascript:`/`data:` (a redirect the browser
      // executes), plaintext http (a downgrade we would be signing off on),
      // protocol-relative `//host` (same-origin by shape, off-origin in
      // effect), and anything else — by name, so a doc the engine should
      // never have sent is visible as such instead of silently dropped.
      if (!isAllowedRedirectTarget(rule.to)) {
        return { ok: false, reason: 'redirect_to_not_allowed' };
      }
      // Defense in depth vs the engine's own loop refusal: a self-redirect is
      // an infinite client loop; never adopt a doc carrying one.
      if (rule.to === rule.from) {
        return { ok: false, reason: 'redirect_self_loop' };
      }
      const statusCode = rule.statusCode;
      if (statusCode !== undefined && statusCode !== 301 && statusCode !== 302 && statusCode !== 307 && statusCode !== 308) {
        return { ok: false, reason: 'invalid_redirect_status' };
      }
      redirects.push(statusCode === undefined ? { from: rule.from, to: rule.to } : { from: rule.from, to: rule.to, statusCode });
    }
    doc.redirects = redirects;
  }

  if (input.headerRules !== undefined) {
    if (typeof input.headerRules !== 'object' || input.headerRules === null || Array.isArray(input.headerRules)) {
      return { ok: false, reason: 'invalid_header_rules' };
    }
    const pathEntries = Object.entries(input.headerRules as Record<string, unknown>);
    if (pathEntries.length > MAX_HEADER_PATHS) return { ok: false, reason: 'header_paths_cap_exceeded' };
    const headerRules: Record<string, Record<string, string | null>> = Object.create(null);
    for (const [path, rawRule] of pathEntries) {
      if (!path.startsWith('/') || path.startsWith(CONTROL_PATH_PREFIX)) {
        return { ok: false, reason: `invalid_header_path:${path}` };
      }
      if (typeof rawRule !== 'object' || rawRule === null || Array.isArray(rawRule)) {
        return { ok: false, reason: `invalid_header_rule:${path}` };
      }
      const headerEntries = Object.entries(rawRule as Record<string, unknown>);
      if (headerEntries.length > MAX_HEADERS_PER_PATH) return { ok: false, reason: `headers_cap_exceeded:${path}` };
      const rule: Record<string, string | null> = Object.create(null);
      for (const [name, value] of headerEntries) {
        if (!/^[A-Za-z0-9-]{1,128}$/.test(name)) return { ok: false, reason: `invalid_header_name:${name}` };
        // D-8: the denylist gate — refuse the WHOLE doc, keep last-good.
        if (isDeniedHeaderName(name)) return { ok: false, reason: `denylisted_header:${name}` };
        if (value !== null && typeof value !== 'string') return { ok: false, reason: `invalid_header_value:${name}` };
        if (typeof value === 'string' && /[\r\n]/.test(value)) return { ok: false, reason: `header_value_crlf:${name}` };
        rule[name] = value as string | null;
      }
      headerRules[path] = rule;
    }
    doc.headerRules = headerRules;
  }

  if (input.slots !== undefined) {
    if (typeof input.slots !== 'object' || input.slots === null || Array.isArray(input.slots)) {
      return { ok: false, reason: 'invalid_slots' };
    }
    const slotEntries = Object.entries(input.slots as Record<string, unknown>);
    if (slotEntries.length > MAX_SLOTS) return { ok: false, reason: 'slots_cap_exceeded' };
    const slots: Record<string, unknown> = Object.create(null);
    for (const [key, value] of slotEntries) {
      if (!SLOT_KEY_RE.test(key)) return { ok: false, reason: `invalid_slot_key:${key}` };
      const opType = key.slice(0, key.indexOf('/'));
      if (opType === 'content') {
        if (typeof value !== 'string' || byteLength(value) > MAX_SLOT_CONTENT_BYTES) {
          return { ok: false, reason: `invalid_content_slot:${key}` };
        }
        slots[key] = value;
        continue;
      }
      if (opType === 'schema') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return { ok: false, reason: `invalid_schema_slot:${key}` };
        }
        if (byteLength(JSON.stringify(value)) > MAX_SLOT_SCHEMA_BYTES) {
          return { ok: false, reason: `schema_slot_cap_exceeded:${key}` };
        }
        slots[key] = JSON.parse(JSON.stringify(value)) as unknown; // detach from parsed graph
        continue;
      }
      // meta
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, reason: `invalid_meta_slot:${key}` };
      }
      const metaCopy: Record<string, string> = Object.create(null);
      for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
        if (!SLOT_META_FIELDS.has(field)) return { ok: false, reason: `invalid_meta_field:${key}.${field}` };
        if (typeof fieldValue !== 'string' || byteLength(fieldValue) > MAX_SLOT_META_FIELD_BYTES) {
          return { ok: false, reason: `invalid_meta_value:${key}.${field}` };
        }
        metaCopy[field] = fieldValue;
      }
      slots[key] = metaCopy;
    }
    doc.slots = slots;
  }

  if (input.heads !== undefined) {
    if (typeof input.heads !== 'object' || input.heads === null || Array.isArray(input.heads)) {
      return { ok: false, reason: 'invalid_heads' };
    }
    const headEntries = Object.entries(input.heads as Record<string, unknown>);
    if (headEntries.length > MAX_HEADS) return { ok: false, reason: 'heads_cap_exceeded' };
    const heads: Record<string, Record<string, unknown>> = Object.create(null);
    for (const [path, rawHead] of headEntries) {
      if (!path.startsWith('/') || path.includes('?') || path.startsWith(CONTROL_PATH_PREFIX)) {
        return { ok: false, reason: `invalid_head_path:${path}` };
      }
      if (typeof rawHead !== 'object' || rawHead === null || Array.isArray(rawHead)) {
        return { ok: false, reason: `invalid_head_entry:${path}` };
      }
      const entry: Record<string, unknown> = Object.create(null);
      for (const [field, value] of Object.entries(rawHead as Record<string, unknown>)) {
        if (!HEAD_FIELDS.has(field)) return { ok: false, reason: `invalid_head_field:${path}.${field}` };
        if (field === 'jsonLd') {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return { ok: false, reason: `invalid_head_jsonld:${path}` };
          }
          if (byteLength(JSON.stringify(value)) > MAX_HEAD_JSONLD_BYTES) {
            return { ok: false, reason: `head_jsonld_cap_exceeded:${path}` };
          }
          entry[field] = JSON.parse(JSON.stringify(value)) as unknown;
          continue;
        }
        if (typeof value !== 'string' || byteLength(value) > MAX_HEAD_TEXT_BYTES || /[\r\n]/.test(value)) {
          return { ok: false, reason: `invalid_head_value:${path}.${field}` };
        }
        entry[field] = value;
      }
      heads[path] = entry;
    }
    doc.heads = heads;
  }

  return { ok: true, doc };
}
