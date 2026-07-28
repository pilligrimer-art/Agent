/**
 * A skill that provides robust structured output parsing for the agent.
 * Inspired by LangChain's JsonOutputParser and AgentParse.
 */

function extractJson(text) {
  // Try to find markdown JSON blocks
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match) {
    text = match[1];
  }
  
  // Find first { and last }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in text");
  }
  
  const jsonStr = text.substring(start, end + 1);
  return JSON.parse(jsonStr);
}

function validateSchema(data, schema) {
  if (!schema) return true; // No schema, pass
  if (schema.type === 'object' && typeof data !== 'object') throw new Error("Expected an object");
  
  if (schema.required) {
    for (const req of schema.required) {
      if (!(req in data)) {
        throw new Error(`Missing required field: ${req}`);
      }
    }
  }
  return true;
}

module.exports = {
  name: "Structured Parser",
  description: "A utility skill for robustly parsing structured JSON outputs, eliminating hallucination patterns. Exposes a tool for the agent to test JSON parsing.",
  tag: "TEST_PARSER",
  syntax: '[TEST_PARSER] {"text_to_parse": "some text with ```json { \\"a\\": 1 } ```"}',
  example: '[TEST_PARSER] {"text_to_parse": "Here is my JSON: { \\"status\\": \\"ok\\" }"}',
  schema: {
    type: "object",
    properties: {
      text_to_parse: { type: "string" }
    },
    required: ["text_to_parse"]
  },
  execute: async (payload, context) => {
    try {
      const parsed = extractJson(payload.text_to_parse);
      return { success: true, log: "Successfully parsed: " + JSON.stringify(parsed) };
    } catch (err) {
      return { success: false, log: "Parse error: " + err.message };
    }
  },
  
  // Export the utility functions for use by other parts of the agent
  extractJson,
  validateSchema
};
