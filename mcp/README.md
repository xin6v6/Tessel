# Self-built MCP Servers

Place your self-built MCP (Model Context Protocol) servers in this directory.

Each MCP server should live in its own subdirectory, e.g.:

```
mcp/
  my-mcp-server/
    index.ts        # or package.json + src/
    ...
```

## Registering an MCP server

Once your MCP server is ready, register it in the project root's `mcp.json` (or `mcp.json.example` for sharing) so Tessel can discover and connect to it.

See the [MCP specification](https://modelcontextprotocol.io/) for details on building MCP servers.
