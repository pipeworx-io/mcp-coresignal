interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Coresignal MCP — LinkedIn-adjacent company + employee data (coresignal.com)
 *
 * Tools:
 * - coresignal_company:  firmographics + headcount for a company (by name or website)
 * - coresignal_employee: professional profile for a person (by name, optional company)
 *
 * Auth: BYO key. Pass _apiKey — sent as the literal `apikey:` header (NOT Bearer).
 *
 * COMPLIANCE: person data. This pack is a pure passthrough of Coresignal's API —
 * it caches nothing, stores nothing, and derives nothing. The caller's own key
 * bears both the COGS and the responsibility for lawful use of the returned data.
 *
 * Pattern: Coresignal's Company/Employee "Base" APIs use a 2-step search->collect
 * flow. A POST to `/{collection}/search/es_dsl` with an Elasticsearch DSL query body
 * returns an array of integer record IDs; a GET to `/{collection}/collect/{id}`
 * returns the full record. Each tool runs the search, collects the FIRST id, and
 * returns that record — plus `total_ids` and an `other_ids` sample so the caller
 * knows more matches exist and can collect them if needed.
 */


const BASE_URL = 'https://api.coresignal.com/cdapi/v2';

const tools: McpToolExport['tools'] = [
  {
    name: 'coresignal_company',
    description:
      "Look up a company's firmographics + headcount (size, employee count, industry, founding year, HQ, LinkedIn URL) from Coresignal by company name or website. LinkedIn-adjacent B2B data. Example: coresignal_company({ name: \"Stripe\", _apiKey: \"your-key\" })",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Company name to look up, e.g. "Stripe", "OpenAI". Provide this OR `website`.',
        },
        website: {
          type: 'string',
          description: 'Company website/domain, e.g. "stripe.com". Provide this OR `name`.',
        },
        _apiKey: {
          type: 'string',
          description: 'Coresignal API key (BYO). Sign up + start a trial at coresignal.com.',
        },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'coresignal_employee',
    description:
      "Find a person's professional profile by name (+company) via Coresignal — returns title, current company, location, LinkedIn URL, work experience and education. LinkedIn-adjacent people data. Example: coresignal_employee({ name: \"Patrick Collison\", company: \"Stripe\", _apiKey: \"your-key\" })",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Full name of the person, e.g. "Patrick Collison".',
        },
        company: {
          type: 'string',
          description: 'Optional company name to disambiguate, e.g. "Stripe".',
        },
        _apiKey: {
          type: 'string',
          description: 'Coresignal API key (BYO). Sign up + start a trial at coresignal.com.',
        },
      },
      required: ['name', '_apiKey'],
    },
  },
];

// ---- shared helpers ---------------------------------------------------------

function requireKey(apiKey: string, tool: string): void {
  if (!apiKey) {
    throw new Error(
      `${tool} requires a Coresignal API key. Pass _apiKey from your Coresignal account (sign up + start a trial at coresignal.com). This is a paid, person-data source — bring your own key.`,
    );
  }
}

function coresignalError(status: number): Error {
  if (status === 401 || status === 403) {
    return new Error(`Coresignal auth failed (HTTP ${status}) — check your Coresignal _apiKey.`);
  }
  if (status === 402) {
    return new Error('Coresignal: out of credits (HTTP 402). Top up your Coresignal account and retry.');
  }
  return new Error(`Coresignal error: HTTP ${status}`);
}

/** POST an Elasticsearch DSL body to a collection's search endpoint. Returns an array of integer IDs. */
async function csSearch(
  base: string,
  collection: string,
  dslBody: unknown,
  apiKey: string,
): Promise<number[]> {
  const res = await fetch(`${base}/${collection}/search/es_dsl`, {
    method: 'POST',
    headers: { apikey: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(dslBody),
  });
  if (!res.ok) throw coresignalError(res.status);
  const data = (await res.json()) as unknown;
  // Search returns a bare JSON array of integer IDs; tolerate an {ids:[...]} envelope.
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as { ids?: unknown }).ids)
      ? (data as { ids: unknown[] }).ids
      : [];
  return arr.map((v) => Number(v)).filter((v) => Number.isFinite(v));
}

/** GET a full record from a collection's collect endpoint by ID. */
async function csCollect(
  base: string,
  collection: string,
  id: number,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/${collection}/collect/${id}`, {
    method: 'GET',
    headers: { apikey: apiKey },
  });
  if (!res.ok) throw coresignalError(res.status);
  return (await res.json()) as Record<string, unknown>;
}

// ---- field helpers ----------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : v == null ? null : String(v);
}

function firstOf(rec: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = rec[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function trunc(v: unknown, max: number): string | null {
  const s = str(v);
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

// ---- tools ------------------------------------------------------------------

async function companyLookup(args: Record<string, unknown>, apiKey: string) {
  requireKey(apiKey, 'coresignal_company');
  const name = str(args.name);
  const website = str(args.website);
  if (!name && !website) {
    throw new Error('coresignal_company requires either `name` (e.g. "Stripe") or `website` (e.g. "stripe.com").');
  }

  const dsl = name
    ? { query: { match: { company_name: name } } }
    : { query: { match: { website } } };

  const ids = await csSearch(BASE_URL, 'company_base', dsl, apiKey);
  if (ids.length === 0) {
    return { query: { name, website }, total_ids: 0, other_ids: [], company: null };
  }

  const rec = await csCollect(BASE_URL, 'company_base', ids[0], apiKey);
  const hq =
    firstOf(rec, ['hq_location', 'headquarters', 'headquarters_new_address', 'location']) ??
    ([rec.headquarters_city, rec.headquarters_state, rec.headquarters_country]
      .filter((p) => typeof p === 'string' && p)
      .join(', ') || null);

  const company = {
    name: str(firstOf(rec, ['company_name', 'name'])),
    website: str(firstOf(rec, ['website', 'company_website'])),
    size: str(firstOf(rec, ['size', 'company_size', 'employees_count_range'])),
    employees_count: firstOf(rec, ['employees_count', 'employee_count', 'size_range']) ?? null,
    industry: str(firstOf(rec, ['industry', 'industry_category'])),
    founded: firstOf(rec, ['founded', 'founded_year', 'year_founded']) ?? null,
    hq_location: str(hq),
    linkedin_url: str(firstOf(rec, ['linkedin_url', 'url', 'canonical_url', 'source_id'])),
    description: trunc(firstOf(rec, ['description', 'company_summary', 'about']), 400),
  };

  return { total_ids: ids.length, other_ids: ids.slice(1, 6), company, raw: rec };
}

async function employeeLookup(args: Record<string, unknown>, apiKey: string) {
  requireKey(apiKey, 'coresignal_employee');
  const name = str(args.name);
  const company = str(args.company);
  if (!name) {
    throw new Error('coresignal_employee requires a `name` (e.g. "Patrick Collison").');
  }

  const must: Array<Record<string, unknown>> = [{ match: { full_name: name } }];
  if (company) must.push({ match: { company_name: company } });
  const dsl = { query: { bool: { must } } };

  const ids = await csSearch(BASE_URL, 'employee_base', dsl, apiKey);
  if (ids.length === 0) {
    return { query: { name, company }, total_ids: 0, other_ids: [], employee: null };
  }

  const rec = await csCollect(BASE_URL, 'employee_base', ids[0], apiKey);

  const experience = asArray(firstOf(rec, ['experience', 'member_experience_collection']))
    .slice(0, 5)
    .map((e) => ({
      title: str(firstOf(e, ['title', 'position_title', 'position'])),
      company: str(firstOf(e, ['company_name', 'company'])),
      date_from: str(firstOf(e, ['date_from', 'starts_at'])),
      date_to: str(firstOf(e, ['date_to', 'ends_at'])),
    }));

  const education = asArray(firstOf(rec, ['education', 'member_education_collection']))
    .slice(0, 3)
    .map((e) => ({
      school: str(firstOf(e, ['title', 'school', 'institution'])),
      degree: str(firstOf(e, ['subtitle', 'degree'])),
      field: str(firstOf(e, ['field_of_study', 'field'])),
    }));

  const employee = {
    name: str(firstOf(rec, ['full_name', 'name'])),
    title: str(firstOf(rec, ['headline', 'active_experience_title', 'title'])),
    company: str(firstOf(rec, ['company_name', 'active_experience_company_name'])),
    location: str(firstOf(rec, ['location', 'location_country', 'country'])),
    linkedin_url: str(firstOf(rec, ['linkedin_url', 'url', 'canonical_url', 'source_id'])),
    experience,
    education,
  };

  return { total_ids: ids.length, other_ids: ids.slice(1, 6), employee, raw: rec };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = args._apiKey as string;
  delete args._apiKey;

  switch (name) {
    case 'coresignal_company':
      return companyLookup(args, apiKey);
    case 'coresignal_employee':
      return employeeLookup(args, apiKey);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// BYO-key only: person data, pure passthrough, no caching. Nominal access meter;
// the caller's Coresignal key bears the real per-record COGS.
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
