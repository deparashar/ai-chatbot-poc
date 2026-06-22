#!/usr/bin/env bash
set -euo pipefail

# ─── Deploy Script ──────────────────────────────────────────────────────────
# Builds the MTA archive and deploys to Cloud Foundry.
# After deploy, re-applies environment variables that are not in mta.yaml.
#
# Usage: ./scripts/deploy.sh
# Prerequisites: cf login, mbt installed

cd "$(dirname "$0")/.."

echo ""
echo "SAP AI Chat — Deploy to BTP"
echo "─────────────────────────────────────────────"
echo ""

# ─── Verify CF login ───────────────────────────────────────────────────────
echo "Checking CF login..."
cf target || { echo "ERROR: Not logged in. Run 'cf login' first."; exit 1; }
echo ""

# ─── Build ──────────────────────────────────────────────────────────────────
echo "Building MTA archive..."
mbt build -t ./
echo ""

MTAR="fiori-chat-poc_1.0.0.mtar"
if [ ! -f "$MTAR" ]; then
  echo "ERROR: $MTAR not found after build"
  exit 1
fi

# ─── Deploy ─────────────────────────────────────────────────────────────────
echo "Deploying $MTAR..."
cf deploy "$MTAR"
echo ""

# ─── Re-apply env vars (not in mta.yaml for security) ─────────────────────
echo "Re-applying environment variables..."
echo ""
echo "NOTE: The following secrets must be set manually after deploy."
echo "They are NOT stored in mta.yaml for security reasons."
echo ""
echo "  # LLM configuration"
echo "  cf set-env fiori-chat-mcp-client LLM_API_KEY '<your-openai-key>'"
echo "  cf set-env fiori-chat-mcp-client LLM_MODEL 'gpt-5.4-mini'"
echo ""
echo "  # MCP server auth (from sap-mcp-xsuaa-SBX service key)"
echo "  printf '%s' 'sb-...!tXXXXX' | xargs -I{} cf set-env fiori-chat-mcp-client MCP_CLIENT_ID \"{}\""
echo "  cf set-env fiori-chat-mcp-client MCP_CLIENT_SECRET '<secret>'"
echo ""
echo "  # MCP server service filtering"
echo "  cf set-env sap-mcp-server-SBX ODATA_SERVICE_PATTERNS '<pattern>'"
echo "  cf set-env sap-mcp-server-SBX ODATA_MAX_SERVICES 200"
echo ""
echo "  # Then restart:"
echo "  cf restart fiori-chat-mcp-client"
echo "  cf restart sap-mcp-server-SBX"
echo ""
echo "Deploy complete."
