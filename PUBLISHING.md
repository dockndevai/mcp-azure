# Publishing `@dockndevai/mcp-azure`

Standard stdio MCP server distributed on npm. Run these from your own accounts.

## 0. Pre-flight
- [ ] CI green; `version` matches in `package.json` and `server.json`.
- [ ] README / `.env.example` / `server.json` list the same env vars; no secrets in examples.

## 1. npm
```bash
npm login
npm publish --access public   # prepublishOnly builds first
```
`package.json` carries `"mcpName": "io.github.dockndevai/mcp-azure"` for registry ownership validation. Then clients can run `npx -y @dockndevai/mcp-azure`.

## 2. Official MCP Registry
```bash
mcp-publisher login github
mcp-publisher publish   # reads ./server.json
```

## 3. Smithery / Glama / Cursor / PulseMCP
Community catalogs that index public GitHub repos (Glama auto-discovers). Keep the README and `server.json` accurate; submit the repo URL where a form is required.

## Automated releases (git tags)
This repo ships [`.github/workflows/release.yml`](.github/workflows/release.yml). Add an npm automation token as the `NPM_TOKEN` secret:
```bash
gh secret set NPM_TOKEN --repo dockndevai/mcp-azure
```
Then `npm version patch` (bump `server.json` to match) and `git push --follow-tags`, or run the workflow from the Actions tab (dry_run toggle).
