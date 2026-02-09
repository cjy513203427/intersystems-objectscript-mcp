# intersystems-objectscript-mcp

Minimal MCP server for InterSystems IRIS (Atelier API). This project is intended to be configured by the **host** (Cursor/Claude Desktop/etc) via `mcp.json`.

## Configuration (recommended): host `mcp.json`

Set connection parameters in the host config using `env`. Example (adjust paths/command for your host):

```json
{
  "mcpServers": {
    "intersystems-objectscript-mcp": {
      "command": "node",
      "args": ["C:/Projekte/Personal/intersystems-objectscript-mcp/node_modules/tsx/dist/cli.mjs", "C:/Projekte/Personal/intersystems-objectscript-mcp/src/index.ts"],
      "env": {
        "IRIS_URL": "http://localhost:63668",
        "IRIS_NAMESPACE": "KELVIN",
        "IRIS_USERNAME": "_SYSTEM",
        "IRIS_PASSWORD": "SYS"
      }
    }
  }
}
```

Notes:
- `IRIS_NAMESPACE` is required and is used as the default namespace when a tool input does not provide one.
- Credentials are sent via HTTP Basic Auth to the Atelier API endpoints.

## Local development (optional): `.env`

For local dev only, you can create a `.env` file (it is ignored by git). The server also supports loading `.env` via `dotenv`.

```bash
npm install
npm run dev
```


