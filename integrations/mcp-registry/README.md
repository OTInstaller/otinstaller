# MCP Registry entry for the remote server

`server.json` lists the registry's read-only remote MCP server (`https://api.otinstaller.com/mcp`, `api/src/mcp.ts`)
in the [MCP Registry](https://registry.modelcontextprotocol.io) as `com.otinstaller/registry`. The local server that
runs tools, `com.otinstaller/ot`, has its own `server.json`, written for each `ot` release by `cli/cmd/mcpb`.

The remote server is deployed with the API Worker, so this entry has its own version: bump `version` when the tools it
offers change, then publish it with `mcp-publisher publish integrations/mcp-registry/server.json` after signing in
with `mcp-publisher login http --domain otinstaller.com --private-key <key>`: the registry checks the key against the
public key the site serves at `/.well-known/mcp-registry-auth` (see `docs/publishing-setup.md`, section 10).
Publishing needs the owner's go-ahead, like any listing.
