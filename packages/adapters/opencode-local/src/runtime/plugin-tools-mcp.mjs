#!/usr/bin/env node
/**
 * plugin-tools-mcp — generic stdio MCP bridge that exposes a Paperclip agent's
 * registered PLUGIN TOOLS to its opencode/claude session at run time.
 *
 * Problem this solves: plugins register tools via `agent.tools.register` and they
 * show up in `paperclipai plugin tools` + the HTTP API, but they were NEVER
 * injected into the agent's tool palette — so agents could not call them. This
 * bridge runs as a stdio MCP subprocess of the agent's session, enumerates the
 * plugin tools via the Paperclip HTTP API, and proxies each tool call back to the
 * API. The agent then sees them as normal MCP tools.
 *
 * How it works:
 *  - On `tools/list`: GET {API}/api/plugins/tools  → map each descriptor to an MCP
 *    tool (sanitized name, description, inputSchema from `parametersSchema`).
 *  - On `tools/call`: POST {API}/api/plugins/tools/execute with
 *    { tool, parameters, runContext:{agentId,runId,companyId,projectId} } built
 *    from the PAPERCLIP_* env this process inherits from the agent run.
 *
 * Env (inherited from the agent run process):
 *   PAPERCLIP_API_URL     (default http://localhost:3100)
 *   PAPERCLIP_API_KEY     (per-run JWT; sent as Bearer for execute auth)
 *   PAPERCLIP_AGENT_ID    (required for runContext + tool filtering)
 *   PAPERCLIP_COMPANY_ID  (required for runContext)
 *   PAPERCLIP_RUN_ID      (required for runContext)
 *   PAPERCLIP_PROJECT_ID  (optional; if missing, resolved from company's projects)
 *   PAPERCLIP_PLUGIN_TOOLS_MCP_PLUGIN_ID  (optional; filter to one pluginId)
 *
 * ZERO dependencies (JSON-RPC 2.0 stdio by hand). Defensive: a failing bridge
 * must NEVER crash the agent session — listing failures expose zero tools, call
 * failures return a clean MCP error. Output is NDJSON (one JSON per line), which
 * is what opencode's StdioClientTransport (and claude) expect.
 */

const API = (process.env.PAPERCLIP_API_URL || "http://localhost:3100").replace(/\/+$/, "");
const API_KEY = process.env.PAPERCLIP_API_KEY || "";
const AGENT_ID = process.env.PAPERCLIP_AGENT_ID || "";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";
const RUN_ID = process.env.PAPERCLIP_RUN_ID || "";
const PLUGIN_FILTER = (process.env.PAPERCLIP_PLUGIN_TOOLS_MCP_PLUGIN_ID || "").trim();
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "paperclip-plugin-tools", version: "0.1.0" };

let cachedProjectId = (process.env.PAPERCLIP_PROJECT_ID || "").trim() || null;

function authHeaders(extra) {
  const h = { Accept: "application/json", ...(extra || {}) };
  if (API_KEY) h.Authorization = `Bearer ${API_KEY}`;
  return h;
}

async function httpJSON(method, urlPath, body, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}${urlPath}`, {
      method,
      headers: authHeaders(body ? { "Content-Type": "application/json" } : undefined),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const txt = await r.text();
    if (!r.ok) {
      throw new Error(`HTTP ${r.status} ${method} ${urlPath}: ${txt.slice(0, 400)}`);
    }
    return txt ? JSON.parse(txt) : {};
  } finally {
    clearTimeout(t);
  }
}

/**
 * MCP tool names must match ^[a-zA-Z0-9_-]+$. Plugin tool names are namespaced
 * like "ceridorio.code-rag:search_code" — sanitize for the wire and keep a
 * reverse map back to the original fully-namespaced name for execute().
 */
const wireToNamespaced = new Map();
function sanitizeName(namespaced) {
  const raw = String(namespaced);
  // Use the SHORT tool name (after the last ':') — OpenCode prefixes MCP tools with the
  // server key ("paperclip-plugin-tools_<name>"), and the full namespaced name overflowed
  // Bedrock's 64-char tool-name limit (adapter_failed fleet-wide). Short name keeps us ~42.
  const short = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
  let wire = (short || raw).replace(/[^a-zA-Z0-9_-]/g, "_");
  // Collision guard: distinct plugins sharing a short name get _2, _3… (reverse map intact).
  if (wireToNamespaced.has(wire) && wireToNamespaced.get(wire) !== raw) {
    let n = 2;
    while (wireToNamespaced.has(`${wire}_${n}`) && wireToNamespaced.get(`${wire}_${n}`) !== raw) n++;
    wire = `${wire}_${n}`;
  }
  wireToNamespaced.set(wire, namespaced);
  return wire;
}

function permissiveSchema(schema) {
  if (schema && typeof schema === "object" && !Array.isArray(schema) && schema.type) {
    return schema;
  }
  return { type: "object", properties: {}, additionalProperties: true };
}

async function listTools() {
  try {
    const qs = PLUGIN_FILTER ? `?pluginId=${encodeURIComponent(PLUGIN_FILTER)}` : "";
    const descriptors = await httpJSON("GET", `/api/plugins/tools${qs}`);
    if (!Array.isArray(descriptors)) return [];
    return descriptors.map((d) => ({
      name: sanitizeName(d.name),
      description:
        (d.description || d.displayName || d.name || "Paperclip plugin tool") +
        `\n\n(Paperclip plugin tool "${d.name}".)`,
      inputSchema: permissiveSchema(d.parametersSchema),
    }));
  } catch (e) {
    // Defensive: never throw on list — expose zero tools so the session stays up.
    process.stderr.write(
      `[plugin-tools-mcp] listTools failed (exposing 0 tools): ${String(e && e.message || e).slice(0, 300)}\n`,
    );
    return [];
  }
}

async function resolveProjectId() {
  if (cachedProjectId) return cachedProjectId;
  if (!COMPANY_ID) return null;
  // The execute endpoint only checks that the project belongs to the company,
  // so any of the company's projects is a valid scope when the run env did not
  // carry an explicit PAPERCLIP_PROJECT_ID.
  try {
    const projects = await httpJSON("GET", `/api/companies/${encodeURIComponent(COMPANY_ID)}/projects`);
    const arr = Array.isArray(projects) ? projects : projects?.projects || [];
    const first = arr.find((p) => p && typeof p.id === "string");
    cachedProjectId = first ? first.id : null;
  } catch (e) {
    process.stderr.write(
      `[plugin-tools-mcp] resolveProjectId failed: ${String(e && e.message || e).slice(0, 200)}\n`,
    );
    cachedProjectId = null;
  }
  return cachedProjectId;
}

async function callTool(wireName, args) {
  const namespaced = wireToNamespaced.get(wireName) || wireName;
  const projectId = await resolveProjectId();
  if (!AGENT_ID || !RUN_ID || !COMPANY_ID || !projectId) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            "Cannot execute plugin tool: missing run context " +
            `(agentId=${!!AGENT_ID}, runId=${!!RUN_ID}, companyId=${!!COMPANY_ID}, projectId=${!!projectId}).`,
        },
      ],
    };
  }
  try {
    const res = await httpJSON("POST", "/api/plugins/tools/execute", {
      tool: namespaced,
      parameters: args || {},
      runContext: { agentId: AGENT_ID, runId: RUN_ID, companyId: COMPANY_ID, projectId },
    });
    const result = res && res.result ? res.result : res;
    if (result && typeof result.error === "string" && result.error.length > 0) {
      return { isError: true, content: [{ type: "text", text: result.error }] };
    }
    const text =
      typeof result?.content === "string" && result.content.length > 0
        ? result.content
        : result?.data !== undefined
          ? JSON.stringify(result.data, null, 2)
          : JSON.stringify(result ?? {}, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `Plugin tool "${namespaced}" failed: ${String(e && e.message || e).slice(0, 500)}` }],
    };
  }
}

// ---- JSON-RPC 2.0 plumbing ----
function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function err(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") {
    const tools = await listTools();
    return ok(id, { tools });
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!name) return err(id, -32602, "tools/call requires a tool name");
    // Ensure the reverse map is populated even if tools/list was not called first.
    if (!wireToNamespaced.has(name)) await listTools();
    const result = await callTool(name, args);
    return ok(id, result);
  }
  if (id !== undefined) return err(id, -32601, `Method not supported: ${method}`);
  return null;
}

let buffer = Buffer.alloc(0);
function send(obj) {
  if (obj == null) return;
  process.stdout.write(JSON.stringify(obj) + "\n");
}

process.stdin.on("data", async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  // Accept both Content-Length framing and NDJSON on input; output is NDJSON.
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd !== -1 && /Content-Length:/i.test(buffer.slice(0, headerEnd).toString())) {
      const m = buffer.slice(0, headerEnd).toString().match(/Content-Length:\s*(\d+)/i);
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + len) break;
      const body = buffer.slice(bodyStart, bodyStart + len).toString("utf8");
      buffer = buffer.slice(bodyStart + len);
      await dispatch(body);
      continue;
    }
    const nl = buffer.indexOf("\n");
    if (nl === -1) break;
    const line = buffer.slice(0, nl).toString("utf8").trim();
    buffer = buffer.slice(nl + 1);
    if (line) await dispatch(line);
  }
});

async function dispatch(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (Array.isArray(msg)) {
    for (const m of msg) send(await handle(m));
    return;
  }
  send(await handle(msg));
}

process.stdin.on("end", () => process.exit(0));
// Never let an unexpected error take down the agent session.
process.on("uncaughtException", (e) => {
  process.stderr.write(`[plugin-tools-mcp] uncaught: ${String(e && e.message || e)}\n`);
});
process.on("unhandledRejection", (e) => {
  process.stderr.write(`[plugin-tools-mcp] unhandledRejection: ${String(e && e.message || e)}\n`);
});
