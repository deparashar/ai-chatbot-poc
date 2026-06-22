#!/usr/bin/env bash
set -euo pipefail

# ─── Status Check Script ───────────────────────────────────────────────────
# Checks the health and status of all deployed apps.
#
# Usage: ./scripts/check-status.sh

echo ""
echo "SAP AI Chat — Status Check"
echo "─────────────────────────────────────────────"
echo ""

# ─── CF Apps ────────────────────────────────────────────────────────────────
echo "CF App Status:"
echo ""
cf apps 2>/dev/null | grep -E "^(name|sap-mcp-server|fiori-chat)" || echo "  (not logged in or no apps found)"
echo ""

# ─── Health Checks ──────────────────────────────────────────────────────────
BASE_ROUTER="https://scania-ieb---poc-sbx-sbx-fiori-chat-router.cfapps.eu10-004.hana.ondemand.com"
BASE_CLIENT="https://scania-ieb---poc-sbx-sbx-fiori-chat-mcp-client.cfapps.eu10-004.hana.ondemand.com"
BASE_MCP="https://scania-ieb---poc-sbx-sbx-sap-mcp-server.cfapps.eu10-004.hana.ondemand.com"

echo "Health Checks:"

# MCP Server
MCP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_MCP}/health" 2>/dev/null || echo "000")
echo "  MCP Server:  ${BASE_MCP}/health → HTTP $MCP_STATUS"

# MCP Client
CLIENT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_CLIENT}/health" 2>/dev/null || echo "000")
echo "  MCP Client:  ${BASE_CLIENT}/health → HTTP $CLIENT_STATUS"

# App Router (will redirect to login if not authenticated)
ROUTER_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -L "${BASE_ROUTER}" 2>/dev/null || echo "000")
echo "  App Router:  ${BASE_ROUTER} → HTTP $ROUTER_STATUS"

echo ""

# ─── Environment Variables ──────────────────────────────────────────────────
echo "Key Environment Variables (fiori-chat-mcp-client):"
cf env fiori-chat-mcp-client 2>/dev/null | grep -E "^(LLM_MODEL|LLM_BASE_URL|MCP_SERVER_URL)" | while read -r line; do
  echo "  $line"
done
echo ""

echo "Key Environment Variables (sap-mcp-server-SBX):"
cf env sap-mcp-server-SBX 2>/dev/null | grep -E "^(ODATA_|DESTINATION_|LOG_LEVEL)" | while read -r line; do
  echo "  $line"
done
echo ""

echo "Done."
