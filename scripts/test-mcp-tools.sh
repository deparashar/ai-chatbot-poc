#!/usr/bin/env bash
set -euo pipefail

# ─── Test MCP Tool Discovery ───────────────────────────────────────────────
# Verifies end-to-end: OAuth token → MCP initialize → tools/list
# Usage: ./scripts/test-mcp-tools.sh

# ─── Configuration ──────────────────────────────────────────────────────────
MCP_SERVER_URL="${MCP_SERVER_URL:-https://scania-ieb---poc-sbx-sbx-sap-mcp-server.cfapps.eu10-004.hana.ondemand.com}"

echo ""
echo "MCP Tool Discovery Test"
echo "─────────────────────────────────────────────"
echo "MCP Server: ${MCP_SERVER_URL}"
echo ""

# ─── Step 1: Get XSUAA credentials from CF ──────────────────────────────────
echo "Step 1: Reading XSUAA credentials from CF environment..."

# Try to read from the MCP client's env (it has MCP_CLIENT_ID/SECRET)
CLIENT_ID=$(cf env fiori-chat-mcp-client 2>/dev/null | grep MCP_CLIENT_ID | head -1 | awk '{print $2}' || echo "")
CLIENT_SECRET=$(cf env fiori-chat-mcp-client 2>/dev/null | grep MCP_CLIENT_SECRET | head -1 | awk '{print $2}' || echo "")

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  echo "  Could not read credentials from CF env."
  echo "  Enter them manually:"
  read -rp "  MCP_CLIENT_ID: " CLIENT_ID
  read -rsp "  MCP_CLIENT_SECRET: " CLIENT_SECRET
  echo ""
fi

# Get UAA URL from VCAP_SERVICES
UAA_URL=$(cf env fiori-chat-mcp-client 2>/dev/null | python3 -c "
import sys, json
try:
  for line in sys.stdin:
    if 'xsuaa' in line.lower():
      break
  vcap = json.loads('{' + sys.stdin.read().split('{', 1)[1])
except:
  pass
" 2>/dev/null || echo "")

if [ -z "$UAA_URL" ]; then
  read -rp "  UAA URL (e.g. https://xxx.authentication.eu10.hana.ondemand.com): " UAA_URL
fi

echo "  Credentials ready."

# ─── Step 2: Get OAuth token ────────────────────────────────────────────────
echo ""
echo "Step 2: Fetching client_credentials token..."

TOKEN_RESPONSE=$(curl -s -X POST \
  "${UAA_URL}/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  --data "grant_type=client_credentials&response_type=token")

TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null || echo "")

if [ -z "$TOKEN" ]; then
  echo "  ERROR: Failed to get OAuth token"
  echo "  Response: $TOKEN_RESPONSE"
  exit 1
fi

echo "  Token obtained (${#TOKEN} chars)."

# ─── Step 3: MCP Initialize ────────────────────────────────────────────────
echo ""
echo "Step 3: MCP Initialize..."

INIT_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "${MCP_SERVER_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "test-script", "version": "1.0.0" }
    }
  }')

INIT_CODE=$(echo "$INIT_RESPONSE" | tail -n1)
INIT_BODY=$(echo "$INIT_RESPONSE" | sed '$d')

# Extract session ID from response header
SESSION_ID=$(curl -s -D - -X POST \
  "${MCP_SERVER_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "test-script", "version": "1.0.0" }
    }
  }' 2>/dev/null | grep -i "mcp-session-id" | awk '{print $2}' | tr -d '\r')

if [ -z "$SESSION_ID" ]; then
  echo "  WARNING: No session ID in response headers"
  echo "  HTTP $INIT_CODE"
else
  echo "  Session ID: $SESSION_ID"
fi

# ─── Step 4: List tools ────────────────────────────────────────────────────
echo ""
echo "Step 4: Listing MCP tools..."

TOOLS_RESPONSE=$(curl -s -X POST \
  "${MCP_SERVER_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer ${TOKEN}" \
  ${SESSION_ID:+-H "mcp-session-id: ${SESSION_ID}"} \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }')

echo "$TOOLS_RESPONSE" | python3 -c "
import sys, json
try:
  # Handle SSE format (data: prefix)
  raw = sys.stdin.read()
  for line in raw.split('\n'):
    line = line.strip()
    if line.startswith('data:'):
      line = line[5:].strip()
    if not line:
      continue
    data = json.loads(line)
    if 'result' in data and 'tools' in data['result']:
      tools = data['result']['tools']
      print(f'  Found {len(tools)} tools:')
      for t in tools:
        print(f'    - {t[\"name\"]}: {t.get(\"description\", \"\")[:80]}')
      break
except Exception as e:
  print(f'  Parse error: {e}')
  print(f'  Raw: {raw[:500]}')
" 2>/dev/null || echo "  Could not parse tools response"

echo ""
echo "Done."
