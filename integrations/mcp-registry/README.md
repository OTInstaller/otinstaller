# MCP Registry entry for the remote server

`server.json` lists the registry's read-only remote MCP server (`https://api.otinstaller.com/mcp`, `api/src/mcp.ts`)
in the [MCP Registry](https://registry.modelcontextprotocol.io) as `com.otinstaller/registry`. The local server that
runs tools, `com.otinstaller/ot`, has its own `server.json`, written for each `ot` release by `cli/cmd/mcpb`.

The remote server is deployed with the API Worker, so this entry has its own version: bump `version` when the tools it
offers change, then publish it with `mcp-publisher publish integrations/mcp-registry/server.json` after the
`otinstaller.com` DNS check (`mcp-publisher login dns --domain otinstaller.com`). Publishing needs the owner's
go-ahead, like any listing.
