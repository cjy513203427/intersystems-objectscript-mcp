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
  IRIS_NAMESPACE: z.string().min(1).default("KELVIN"),
  IRIS_USERNAME: z.string().min(1, "IRIS_USERNAME is required").default("_SYSTEM"),
  IRIS_PASSWORD: z.string().min(1, "IRIS_PASSWORD is required").default("SYS"),
});

type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Logs must go to stderr in stdio mode to avoid corrupting the protocol stream.
    console.error("环境变量校验失败：");
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
    return `无法识别的 SQL 返回格式：\n${extractVersionInfo(content)}`;
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

async function executeSQL(env: Env, namespace: string, query: string): Promise<string> {
  const client = createIrisClient(env);
  const ns = namespace;

  // Note: Some IRIS/Atelier versions expose SQL query via /action/query (not /query).
  const endpointCandidates = [
    `/api/atelier/v1/${encodeURIComponent(ns)}/query`,
    `/api/atelier/v1/${encodeURIComponent(ns)}/action/query`,
  ];

  const candidates: Array<{ label: string; body: unknown }> = [
    { label: 'body={"query": "..."}', body: { query } },
    { label: 'body={"sql": "..."}', body: { sql: query } },
    { label: 'body={"query": {"sql":"..."}}', body: { query: { sql: query } } },
  ];

  let lastAxiosErr: unknown = null;
  for (const endpoint of endpointCandidates) {
    for (const c of candidates) {
      try {
        const res = await client.post(endpoint, c.body);
        const content = extractQueryContent(res.data);
        return formatMarkdownTable(content);
      } catch (err: unknown) {
        lastAxiosErr = err;
        if (axios.isAxiosError(err)) {
          const status = err.response?.status;
          // If endpoint is not found, try the next endpoint path.
          if (status === 404) break;
          // If server rejects the body shape/content-type, try the next candidate.
          if (status === 400 || status === 415 || status === 422) {
            continue;
          }
        }
        throw err;
      }
    }
  }

  if (axios.isAxiosError(lastAxiosErr)) {
    const status = lastAxiosErr.response?.status ?? "unknown";
    const snippet = extractVersionInfo(lastAxiosErr.response?.data ?? lastAxiosErr.message);
    return `SQL 执行失败（已尝试多种端点与请求体格式）。HTTP ${status}\n${snippet}`;
  }

  return `SQL 执行失败：${String(lastAxiosErr ?? "unknown error")}`;
}

async function verifyConnection(env: Env): Promise<void> {
  const client = createIrisClient(env);

  try {
    // user_story.md step2 expects /api/atelier/ as the first HTTP link.
    const res = await client.get("/api/atelier/");
    console.error("IRIS 连接成功。");
    console.error(`HTTP ${res.status}`);
    console.error(`Atelier info: ${extractVersionInfo(res.data)}`);
  } catch (err: unknown) {
    console.error("IRIS 连接失败。");
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
  const verifyOnly = process.argv.includes("--verify-only");

  await verifyConnection(env);
  if (verifyOnly) return;

  const server = new McpServer({
    name: "intersystems-objectscript-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "ping",
    {
      description: "Health check for MCP connectivity.",
      inputSchema: z.object({}),
    },
    async () => {
      return {
        content: [{ type: "text", text: "pong" }],
      };
    },
  );

  server.registerTool(
    "get_iris_routine",
    {
      description:
        "Read-only: fetch compiled routine (.int) content from IRIS. Does not modify any code.",
      inputSchema: z.object({
        name: z.string().min(1),
        namespace: z.string().min(1).optional(),
      }),
    },
    async ({ name, namespace }) => {
      const resolvedNamespace = namespace ?? env.IRIS_NAMESPACE;
      const routineName = name.endsWith(".cls") ? name.replace(/\.cls$/, ".1.int") : name;
      const client = createIrisClient(env);

      try {
        const res = await client.get(
          `/api/atelier/v1/${encodeURIComponent(resolvedNamespace)}/doc/${encodeURIComponent(
            routineName,
          )}`,
        );
        // Atelier doc responses are typically { result: { name, cat, content: string[] } }.
        const result = res.data?.result ?? res.data;
        const lines = Array.isArray(result?.content) ? result.content : null;
        const header = `[IRIS routine] name=${String(result?.name ?? routineName)} cat=${String(
          result?.cat ?? "unknown",
        )}`;
        const content = lines ? `${header}\n${lines.join("\n")}` : `${header}\n${extractVersionInfo(res.data)}`;
        return {
          content: [{ type: "text", text: content }],
        };
      } catch (err: unknown) {
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          return {
            content: [
              {
                type: "text",
                text: "未找到对应的 routine 文档（例如 .1.int）。请确认类已编译且该 namespace 下存在生成的 .1.int。",
              },
            ],
          };
        }
        const details = axios.isAxiosError(err)
          ? err.message
          : String(err);
        return {
          content: [{ type: "text", text: `获取失败：${details}` }],
        };
      }
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
          content: [{ type: "text", text: `执行失败：${details}` }],
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
  console.error("启动失败：");
  console.error(err);
  process.exit(1);
});


