const axios = require('axios');

// Mock axios BEFORE requiring index.js so the mock is used
let callCount = 0;
axios.post = async (url, data) => {
  callCount++;
  // We simulate a model that always outputs the EXACT same self-question.
  // It also outputs TOPIC_SCORE 6.
  const mockedResponse = `
REASONING: I am generating a question.
[SELF_QUESTION "What is the meaning of life?"]
[TOPIC_SCORE 6]
  `;
  return { data: { response: mockedResponse } };
};

const { runAgent, getAgentState, getChatHistory } = require('./index');
const scheduler = require('./scheduler');

// Suppress console logs during test to keep output clean, unless we want to see them
// const originalLog = console.log;
// console.log = () => {};

async function runTest() {
  console.log("=== Starting Regression Test: Duplicate Curiosity Loop ===");
  
  // Cycle 1
  console.log("\\n--- Running Cycle 1 ---");
  await runAgent();
  let state = getAgentState();
  console.log("State after Cycle 1 (expecting lastThought to have the question):", state.lastThought ? "YES" : "NO");

  // Cycle 2 (model repeats exact same question)
  console.log("\\n--- Running Cycle 2 ---");
  await runAgent();
  
  // Since it was rejected, the `pendingMessages` (injected via `injectSystemMessage`) should have the [MALFORMED_INTENT] tag.
  // To verify this, we run Cycle 3 and see if the prompt for Cycle 3 contains the warning.
  
  // Let's hook the axios.post to intercept the prompt for Cycle 3
  let promptForCycle3 = "";
  axios.post = async (url, data) => {
    promptForCycle3 = data.prompt;
    return { data: { response: "End of test." } };
  };
  
  console.log("\\n--- Running Cycle 3 to check injected system message ---");
  await runAgent();
  
  if (promptForCycle3.includes('[MALFORMED_INTENT "duplicate_self_question"]')) {
    console.log("\\n✅ PASS: Duplicate self-question was correctly blocked and the system message was injected.");
  } else {
    console.log("\\n❌ FAIL: The duplicate question was not blocked, or the system message was missing.");
    console.log("Prompt was:\\n", promptForCycle3);
    process.exit(1);
  }
}

runTest().catch(err => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
