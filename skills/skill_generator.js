const fs = require('fs');
const path = require('path');

module.exports = {
  name: "Skill Generator",
  description: "Writes a new skill to the skills/ directory. The code must export an object with name, description, tag, syntax, example, schema, and an execute(payload, context) function.",
  tag: "CREATE_SKILL",
  syntax: '[CREATE_SKILL] {"filename": "my_skill.js", "code": "module.exports = { ... }" }',
  example: '[CREATE_SKILL] {"filename": "hello.js", "code": "module.exports = { name: \\"Hello\\", tag: \\"HELLO\\", execute: () => { return { log: \\"World\\" } } }"}',
  schema: {
    type: "object",
    properties: {
      filename: { type: "string" },
      code: { type: "string" }
    },
    required: ["filename", "code"]
  },
  execute: async (payload, context) => {
    try {
      if (!payload.filename.endsWith('.js')) {
        return { success: false, log: "Filename must end with .js" };
      }
      const skillPath = path.join(__dirname, payload.filename);
      fs.writeFileSync(skillPath, payload.code, 'utf8');
      
      // Try to require it to validate syntax
      try {
        delete require.cache[require.resolve(skillPath)];
        const newSkill = require(skillPath);
        if (!newSkill.tag || typeof newSkill.execute !== 'function') {
          return { success: false, log: "Skill created but it lacks a 'tag' or 'execute' function." };
        }
      } catch (err) {
        return { success: false, log: "Skill created but failed to load: " + err.message };
      }
      
      return { success: true, log: `Skill ${payload.filename} successfully created and validated. It will be loaded on the next cycle.` };
    } catch (err) {
      return { success: false, log: "Failed to create skill: " + err.message };
    }
  }
};
