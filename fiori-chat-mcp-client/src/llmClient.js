'use strict';

const OpenAI = require('openai');

const client = new OpenAI.default({
  apiKey: process.env.LLM_API_KEY,
  baseURL: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
});

const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

const BASE_SYSTEM_PROMPT = `You are an expert SAP business data assistant. You help users explore and query SAP OData services through a set of tools.

## Your Tools
1. **discover-sap-data** — Find available OData services. Use \`query\` to search by name, or omit it to list all. Always use limit=5.
2. **get-entity-metadata** — Get the entity sets and fields for a specific service. Requires the exact \`serviceId\`.
3. **execute-sap-operation** — Read data from an entity set. Requires exact \`serviceId\` and \`entityName\`.

## Key Behavior
- If a **Service Catalog** is provided below, use the exact serviceId from it — call get-entity-metadata directly WITHOUT calling discover-sap-data first. This saves a round trip.
- Only call discover-sap-data when the user asks about a service NOT in the catalog, or asks "what services are available".
- When a tool result includes **auto-fetched records**, do NOT call execute-sap-operation again — the data is already there. Just format it.
- Call discover-sap-data at most ONCE per turn. If it returns no matches, tell the user and stop.
- If any tool returns an error, explain it clearly and stop. Do not retry.

## Response Style
- Be conversational and helpful — explain what you found.
- Format data as **Markdown tables** when showing records (use | column | headers |).
- Use **bold** for field names and service names.
- Use bullet points for lists of services or entities.
- Add a brief summary sentence after presenting data (e.g., "Showing 5 of 120 travel bookings").
- If the data has dates, format them readably (e.g., "Mar 15, 2026" not "20260315").
- Keep responses concise but informative.`;

/**
 * Converts MCP tool definitions to OpenAI function-calling format.
 */
function toOpenAITools(mcpTools) {
  return mcpTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/**
 * Builds the full system prompt, optionally injecting the pre-loaded service catalog.
 */
function buildSystemPrompt(serviceCatalog) {
  if (!serviceCatalog) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}\n\n## Pre-loaded Service Catalog\nThese services are already discovered. Use the exact serviceId to call get-entity-metadata directly — no need to call discover-sap-data for these.\n\n${serviceCatalog}`;
}

/**
 * Sends messages + tools to the LLM and returns the response message.
 */
async function chat(messages, openAITools, serviceCatalog) {
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: buildSystemPrompt(serviceCatalog) }, ...messages],
    tools: openAITools,
    tool_choice: 'auto',
    temperature: 0.3,
    max_tokens: 4096,
  });

  const message = response.choices[0].message;
  const usage = response.usage || {};
  message._tokenUsage = {
    prompt: usage.prompt_tokens || 0,
    completion: usage.completion_tokens || 0,
    total: usage.total_tokens || 0,
  };
  return message;
}

module.exports = { chat, toOpenAITools };
