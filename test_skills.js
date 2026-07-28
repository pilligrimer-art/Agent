const { parseOutput } = require('./agent/output_parser');
const memState = require('./agent/index'); // actually we might need to mock or just run index.js's main loop

// Let's just run agent/index.js in a single run mode.
process.env.RUN_ONCE = '1';

// We inject a user message and run the cycle.
const index = require('./agent/index');
index.pushUserMessage('[GIT_SYNC] {"message": "Add modular skills subsystem"}');

console.log("Running agent test cycle...");
index.main();
