const db = require('./agent/db');
const rows = db.prepare('SELECT id, content FROM long_mem ORDER BY created DESC').all();
console.log(JSON.stringify(rows, null, 2));
