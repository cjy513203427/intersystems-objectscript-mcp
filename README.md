# intersystems-objectscript-routine-mcp

Read-only MCP server for InterSystems IRIS via the Atelier API. It is designed for hosts such as Cursor or Claude Desktop and helps an LLM inspect compiled ObjectScript routines without modifying code.

GitHub is for understanding the project and reviewing the source. npm is for the shortest path to a working MCP server. The `repository` field connects both.

## What this server does

- Fetch compiled routines such as `.int`, `.mac`, and `.inc`
- Auto-resolve bare class names such as `Package.Class` to compiled routine candidates like `Package.Class.1.int`
- List accessible include files in a namespace
- Fail fast on common connection and authentication problems

## Tools

### `get_iris_routine`

Fetches the content of a compiled routine from IRIS.

- Input: `name`, optional `namespace`
- Read-only
- If you pass a class name, the server tries `.1.int` and `.int` automatically

### `list_iris_includes`

Lists accessible `.inc` files in an IRIS namespace.

- Input: optional `namespace`
- Read-only
- Uses the Atelier `action/query` endpoint and requires SQL access to `%Library.RoutineMgr_StudioOpenDialog`

## Requirements

- Node.js `>=20.0.0`
- A reachable InterSystems IRIS instance with the Atelier API available
- HTTP Basic Auth credentials with permission to read routines
- A valid default namespace via `IRIS_NAMESPACE`

## Quick start

### Option A: npm-based setup

Use this if you want the smallest amount of local setup and a host config that runs immediately.

Recommended host `mcp.json`:

```json
{
  "mcpServers": {
    "intersystems-objectscript-routine-mcp": {
      "command": "npx",
      "args": ["-y", "intersystems-objectscript-routine-mcp"],
      "env": {
        "IRIS_URL": "http://localhost:52773",
        "IRIS_NAMESPACE": "USER",
        "IRIS_USERNAME": "_SYSTEM",
        "IRIS_PASSWORD": "SYS"
      }
    }
  }
}
```

Notes:

- This is the recommended published-package path
- If you prefer a global install, run `npm install -g intersystems-objectscript-routine-mcp` and set `command` to `intersystems-objectscript-routine-mcp`

### Option B: clone-based setup

Use this if you want to inspect or modify the source before running it.

```bash
git clone https://github.com/cjy513203427/intersystems-objectscript-mcp.git
cd intersystems-objectscript-mcp
npm install
```

Host `mcp.json` for the cloned repository (pattern verified with Cursor: `npx` + `tsx`, `cwd` set to the repo root). Replace `<path-to-repo>` with your clone path (use forward slashes on Windows, e.g. `C:/Projekte/...`).

```json
{
  "mcpServers": {
    "iris-objectscript-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "<path-to-repo>/src/index.ts"],
      "cwd": "<path-to-repo>",
      "env": {
        "IRIS_URL": "http://localhost:52773",
        "IRIS_NAMESPACE": "USER",
        "IRIS_USERNAME": "_SYSTEM",
        "IRIS_PASSWORD": "SYS"
      }
    }
  }
}
```

Notes:

- The server key (`iris-objectscript-mcp` here) is only a label in the host; it can differ from the npm package name.
- Run `npm install` in the repo first so dependencies and `tsx` resolve reliably.
- Alternative: `node` + `node_modules/tsx/dist/cli.mjs` works the same; `npx tsx` is often shorter to configure.

## Environment variables

The host can pass connection settings through `env`. For local development, you can also create a `.env` file based on `.env.example`.

| Variable | Required | Description |
| --- | --- | --- |
| `IRIS_URL` | Yes | Base URL of your IRIS instance, for example `http://localhost:52773` |
| `IRIS_NAMESPACE` | Yes | Default namespace used when a tool call does not pass one |
| `IRIS_USERNAME` | Yes | Username for HTTP Basic Auth |
| `IRIS_PASSWORD` | Yes | Password for HTTP Basic Auth |

## Troubleshooting

### Connection refused or timeout

- Verify `IRIS_URL`
- Open `<IRIS_URL>/api/atelier/` in a browser or with `curl`
- Confirm the IRIS web server and port are reachable from the machine running the MCP host

### `401` or `403`

- Recheck `IRIS_USERNAME` and `IRIS_PASSWORD`
- Confirm the account can access the Atelier API for the target namespace

### Routine not found

- Confirm the class or routine has been compiled
- Try the correct namespace explicitly
- For class names, remember that the server looks for compiled routine names such as `.1.int`

### Include listing returns zero results

- Confirm the namespace actually contains `.inc` files
- Confirm the account can execute `%Library.RoutineMgr_StudioOpenDialog`

## Security notes

- Keep credentials in local host configuration or a local `.env` file only
- Do not commit secrets to Git
- Prefer least-privilege IRIS credentials for read-only inspection

## Development

```bash
npm install
npm run dev
```

Build the published entry:

```bash
npm run build
```


