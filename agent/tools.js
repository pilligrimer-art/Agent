const fs = require('fs');
const path = require('path');
const config = require('./config');

const WORKSPACE_DIR = path.join(config.rootDir, 'workspace');

// Ensure workspace exists
if (!fs.existsSync(WORKSPACE_DIR)) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

function resolveSecurePath(targetPath) {
  const resolved = path.resolve(WORKSPACE_DIR, targetPath.replace(/^"|"$/g, '').trim());
  if (!resolved.startsWith(WORKSPACE_DIR)) {
    throw new Error('Access denied: Path is outside workspace sandbox.');
  }
  return resolved;
}

function mcpList(targetPath) {
  try {
    const dir = resolveSecurePath(targetPath || '');
    if (!fs.existsSync(dir)) return `<ERROR> Directory not found: ${targetPath}</ERROR>`;
    const stats = fs.statSync(dir);
    if (!stats.isDirectory()) return `<ERROR> Not a directory: ${targetPath}</ERROR>`;
    
    const files = fs.readdirSync(dir);
    let output = `<UNTRUSTED_DIR_LIST path="${targetPath}">\n`;
    output += files.length ? files.join('\n') : '(empty directory)';
    output += `\n</UNTRUSTED_DIR_LIST>`;
    return output;
  } catch (err) {
    return `<ERROR> ${err.message}</ERROR>`;
  }
}

function mcpRead(targetPath) {
  try {
    if (!targetPath) return `<ERROR> Path required for MCP_READ</ERROR>`;
    const file = resolveSecurePath(targetPath);
    if (!fs.existsSync(file)) return `<ERROR> File not found: ${targetPath}</ERROR>`;
    const stats = fs.statSync(file);
    if (!stats.isFile()) return `<ERROR> Not a file: ${targetPath}</ERROR>`;
    
    let content = fs.readFileSync(file, 'utf8');
    if (content.length > 2000) {
      content = content.substring(0, 2000) + '\n...[TRUNCATED TO 2000 CHARS]...';
    }
    
    let output = `<UNTRUSTED_FILE_CONTENT path="${targetPath}">\n`;
    output += content;
    output += `\n</UNTRUSTED_FILE_CONTENT>`;
    return output;
  } catch (err) {
    return `<ERROR> ${err.message}</ERROR>`;
  }
}

module.exports = { mcpList, mcpRead };
