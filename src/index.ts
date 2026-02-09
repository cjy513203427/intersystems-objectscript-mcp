import "dotenv/config";

import axios from "axios";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const EnvSchema = z.object({
  IRIS_URL: z
    .string()
    .min(1, "IRIS_URL is required")
    .default("http://localhost:63668"),
  IRIS_NAMESPACE: z.string().min(1, "IRIS_NAMESPACE is required"),
  IRIS_USERNAME: z.string().min(1, "IRIS_USERNAME is required").default("_SYSTEM"),
  IRIS_PASSWORD: z.string().min(1, "IRIS_PASSWORD is required").default("SYS"),
});

type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Logs must go to stderr in stdio mode to avoid corrupting the protocol stream.
    console.error("Environment variable validation failed:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

function normalizeBaseUrl(url: string): string {
  // Remove trailing slashes to avoid accidental double-slashes when joining paths.
  return url.replace(/\/+$/, "");
}

function createIrisClient(env: Env) {
  return axios.create({
    baseURL: normalizeBaseUrl(env.IRIS_URL),
    auth: {
      username: env.IRIS_USERNAME,
      password: env.IRIS_PASSWORD,
    },
    headers: {
      "Content-Type": "application/json",
    },
    timeout: 30_000,
  });
}

function extractVersionInfo(data: unknown): string {
  if (data == null) return "No response body.";
  if (typeof data === "object") {
    try {
      const json = JSON.stringify(data);
      // Best-effort: some endpoints may include version-like fields.
      const m =
        /"version"\s*:\s*"([^"]+)"/i.exec(json) ??
        /"irisVersion"\s*:\s*"([^"]+)"/i.exec(json) ??
        /"productVersion"\s*:\s*"([^"]+)"/i.exec(json);
      if (m?.[1]) return `version=${m[1]}`;
      return JSON.stringify(data, null, 2).slice(0, 400);
    } catch {
      return "Received non-serializable object body.";
    }
  }
  if (typeof data === "string") {
    // If response is HTML/text, print a short snippet.
    const snippet = data.replace(/\s+/g, " ").slice(0, 400);
    return snippet.length > 0 ? snippet : "Empty string body.";
  }
  return String(data);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeMarkdownCell(value: string): string {
  // Keep the table stable: escape pipes and normalize newlines.
  return value.replaceAll("|", "\\|").replaceAll("\r\n", "\n").replaceAll("\n", "<br>");
}

function toCellString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatMarkdownTable(content: unknown): string {
  if (!Array.isArray(content)) {
    return `Unrecognized SQL response format:\n${extractVersionInfo(content)}`;
  }

  if (content.length === 0) {
    return "_(empty result)_";
  }

  // Case 1: array of plain objects => union keys as columns.
  if (content.every((row) => isPlainObject(row))) {
    const rows = content as Array<Record<string, unknown>>;
    const columns: string[] = [];
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (!columns.includes(k)) columns.push(k);
      }
    }
    if (columns.length === 0) columns.push("value");

    const header = `| ${columns.map(escapeMarkdownCell).join(" | ")} |`;
    const sep = `| ${columns.map(() => "---").join(" | ")} |`;
    const body = rows
      .map((r) => `| ${columns.map((c) => escapeMarkdownCell(toCellString(r[c]))).join(" | ")} |`)
      .join("\n");

    return [header, sep, body].filter(Boolean).join("\n");
  }

  // Case 2: array of arrays => treat as rows; first row may be header.
  if (content.every((row) => Array.isArray(row))) {
    const rows = content as unknown[][];
    const maxLen = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const row0 = rows[0] ?? [];
    const row1 = rows[1] ?? null;
    const hasHeader =
      row1 != null &&
      row0.length > 0 &&
      row0.length === (row1 as unknown[]).length &&
      row0.every((v) => typeof v === "string");

    const headerCells = hasHeader
      ? (row0.map((v) => escapeMarkdownCell(String(v))) as string[])
      : Array.from({ length: Math.max(maxLen, 1) }, (_, i) => `col${i + 1}`);

    const dataRows = hasHeader ? rows.slice(1) : rows;
    const normalized = dataRows.map((r) => {
      const cells = [...r];
      while (cells.length < headerCells.length) cells.push("");
      return cells.slice(0, headerCells.length);
    });

    const header = `| ${headerCells.join(" | ")} |`;
    const sep = `| ${headerCells.map(() => "---").join(" | ")} |`;
    const body = normalized
      .map((r) => `| ${r.map((v) => escapeMarkdownCell(toCellString(v))).join(" | ")} |`)
      .join("\n");

    return [header, sep, body].filter(Boolean).join("\n");
  }

  // Case 3: array of strings (or mixed scalars) => single-column table.
  const header = "| value |";
  const sep = "| --- |";
  const body = content.map((v) => `| ${escapeMarkdownCell(toCellString(v))} |`).join("\n");
  return [header, sep, body].join("\n");
}

function extractQueryContent(data: unknown): unknown {
  if (!isPlainObject(data)) return data;
  const result = isPlainObject(data.result) ? data.result : null;
  if (result && "content" in result) return (result as Record<string, unknown>).content;
  if ("content" in data) return data.content;
  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRoutineDocCandidates(inputName: string): string[] {
  // Candidates are tried in order; keep it conservative and predictable.
  const name = inputName.trim();
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (v: string) => {
    const vv = v.trim();
    if (!vv) return;
    if (seen.has(vv)) return;
    seen.add(vv);
    out.push(vv);
  };

  // If user provides a class name (with or without .cls), prefer the compiled routine (.1.int).
  if (/\.cls$/i.test(name)) {
    add(name.replace(/\.cls$/i, ".1.int"));
    add(name.replace(/\.cls$/i, ".int"));
    return out;
  }

  // If user provides a routine name already.
  if (/\.int$/i.test(name) || /\.mac$/i.test(name) || /\.inc$/i.test(name)) {
    add(name);
    return out;
  }

  // Bare class name: try common compiled routine name shapes first.
  add(`${name}.1.int`);
  add(`${name}.int`);
  // As a last resort, try the input verbatim (might already be a doc name on some systems).
  add(name);
  return out;
}

function isLikelyNetworkMisconfig(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (err.response) return false;
  const code = err.code ?? "";
  return [
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
  ].includes(code);
}

function shouldRetryOnce(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const status = err.response?.status;
  // Only retry a small set of transient server errors.
  return status === 502 || status === 503 || status === 504;
}

async function executeSQL(env: Env, namespace: string, query: string): Promise<string> {
  const client = createIrisClient(env);
  const ns = namespace;

  try {
    const res = await client.post(`/api/atelier/v1/${encodeURIComponent(ns)}/action/query`, {
      query,
    });
    const content = extractQueryContent(res.data);
    return formatMarkdownTable(content);
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status ?? "unknown";
      const snippet = extractVersionInfo(err.response?.data ?? err.message);
      return `SQL execution failed. HTTP ${status}\n${snippet}`;
    }
    return `SQL execution failed: ${String(err)}`;
  }
}

async function verifyConnection(env: Env): Promise<void> {
  const client = createIrisClient(env);

  try {
    // user_story.md step2 expects /api/atelier/ as the first HTTP link.
    const res = await client.get("/api/atelier/");
    console.error("IRIS connection successful.");
    console.error(`HTTP ${res.status}`);
    console.error(`Atelier info: ${extractVersionInfo(res.data)}`);
  } catch (err: unknown) {
    console.error("IRIS connection failed.");
    if (axios.isAxiosError(err)) {
      if (err.response) {
        console.error(`HTTP ${err.response.status}`);
        console.error(extractVersionInfo(err.response.data));
      } else {
        // Provide more details for network/TLS/DNS errors.
        console.error(`Request URL: ${err.config?.baseURL ?? ""}${err.config?.url ?? ""}`);
        if (err.code) console.error(`Error code: ${err.code}`);
        console.error(err.message);
      }
    } else {
      console.error(String(err));
    }
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const env = parseEnv();
  await verifyConnection(env);

  const server = new McpServer({
    name: "intersystems-objectscript-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "get_iris_routine",
    {
      description:
        "Read-only: fetch compiled routine (.int) content from IRIS. Auto-completes bare class names (e.g. 'Pkg.Class') by trying '.1.int' and '.int'. Does not modify any code.",
      inputSchema: z.object({
        name: z.string().min(1),
        namespace: z.string().min(1).optional(),
      }),
    },
    async ({ name, namespace }) => {
      const resolvedNamespace = namespace ?? env.IRIS_NAMESPACE;
      const client = createIrisClient(env);

      const candidates = buildRoutineDocCandidates(name);
      const tried: Array<{ name: string; status?: number; message?: string }> = [];

      for (const candidate of candidates) {
        const url = `/api/atelier/v1/${encodeURIComponent(resolvedNamespace)}/doc/${encodeURIComponent(candidate)}`;

        // Important: keep this tool responsive. Avoid long hangs on misconfigured ports.
        // We do a single attempt per candidate, and at most one extra retry for transient 5xx.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await client.get(url, { timeout: 10_000 });
            // Atelier doc responses are typically { result: { name, cat, content: string[] } }.
            const result = res.data?.result ?? res.data;
            const lines = Array.isArray(result?.content) ? result.content : null;
            const header = `[IRIS routine] name=${String(result?.name ?? candidate)} cat=${String(
              result?.cat ?? "unknown",
            )}`;
            const content = lines
              ? `${header}\n${lines.join("\n")}`
              : `${header}\n${extractVersionInfo(res.data)}`;
            return {
              content: [{ type: "text", text: content }],
            };
          } catch (err: unknown) {
            if (isLikelyNetworkMisconfig(err)) {
              // Fast-fail for common port/DNS/timeout issues; don't keep the user waiting.
              const ax = axios.isAxiosError(err) ? err : null;
              const code = ax?.code ? ` (${ax.code})` : "";
              const hint =
                `无法连接到 IRIS${code}。请检查 IRIS_URL/端口、网络连通性与 Basic Auth。` +
                `\n- IRIS_URL: ${env.IRIS_URL}` +
                `\n- 尝试访问: ${normalizeBaseUrl(env.IRIS_URL)}/api/atelier/`;
              return { content: [{ type: "text", text: hint }] };
            }

            if (axios.isAxiosError(err)) {
              const status = err.response?.status;
              tried.push({ name: candidate, status, message: err.message });

              // Not a valid doc name or not found => try next candidate.
              if (status === 400 || status === 404) break;

              // Auth / permission issues should surface immediately.
              if (status === 401 || status === 403) {
                const snippet = extractVersionInfo(err.response?.data ?? err.message);
                return {
                  content: [{ type: "text", text: `认证/权限失败（HTTP ${status}）。\n${snippet}` }],
                };
              }

              // Retry once for transient 5xx, then fall through to return a generic error.
              if (attempt === 0 && shouldRetryOnce(err)) {
                await sleep(250);
                continue;
              }

              const snippet = extractVersionInfo(err.response?.data ?? err.message);
              return {
                content: [{ type: "text", text: `获取 routine 失败（HTTP ${status ?? "unknown"}）。\n${snippet}` }],
              };
            }

            // Non-Axios errors: return a generic failure without retry loops.
            return { content: [{ type: "text", text: `获取 routine 失败：${String(err)}` }] };
          }
        }
      }

      // If we reach here, all candidates were 400/404.
      const list = candidates.map((c) => `- ${c}`).join("\n");
      return {
        content: [
          {
            type: "text",
            text:
              `未找到对应的 routine 文档。\n已尝试以下名称：\n${list}\n\n` +
              `请确认：\n- 类已编译（会生成 *.1.int）\n- namespace 正确：${resolvedNamespace}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "execute_iris_sql",
    {
      description: "Read-only: execute SQL via Atelier query endpoint and return results as a Markdown table.",
      inputSchema: z.object({
        query: z.string().min(1),
        namespace: z.string().min(1).optional(),
      }),
    },
    async ({ query, namespace }) => {
      const resolvedNamespace = namespace ?? env.IRIS_NAMESPACE;
      try {
        const md = await executeSQL(env, resolvedNamespace, query);
        return {
          content: [{ type: "text", text: md }],
        };
      } catch (err: unknown) {
        const details = axios.isAxiosError(err)
          ? extractVersionInfo(err.response?.data ?? err.message)
          : String(err);
        return {
          content: [{ type: "text", text: `Execution failed: ${details}` }],
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Important: use stderr for logs in stdio transport.
  console.error("MCP server started (stdio).");
}

main().catch((err) => {
  console.error("Startup failed:");
  console.error(err);
  process.exit(1);
});


