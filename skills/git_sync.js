const { execSync } = require('child_process');

module.exports = {
  name: "Git Sync",
  description: "Allows the agent to commit and push its current state (memory, code, skills) to the remote repository.",
  tag: "GIT_SYNC",
  syntax: '[GIT_SYNC] {"message": "<commit_message>"}',
  example: '[GIT_SYNC] {"message": "Learned a new skill and updated memory"}',
  schema: {
    type: "object",
    properties: {
      message: { type: "string" }
    },
    required: ["message"]
  },
  execute: async (payload, context) => {
    try {
      const msg = payload.message || "Auto-commit by Autonomous Agent";
      
      // We run this synchronously for simplicity in the agent loop
      execSync('git add .', { encoding: 'utf8' });
      
      // Check if there are changes to commit
      const status = execSync('git status --porcelain', { encoding: 'utf8' });
      if (!status.trim()) {
        return { success: false, log: "No changes to commit." };
      }
      
      execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
      const pushResult = execSync('git push origin main', { encoding: 'utf8' });
      
      return { success: true, log: "Successfully pushed to origin/main.\\n" + pushResult };
    } catch (err) {
      return { success: false, log: "Git error: " + (err.stderr || err.message) };
    }
  }
};
