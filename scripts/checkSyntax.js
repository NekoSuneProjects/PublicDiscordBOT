const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('fs-extra');

const root = process.cwd();
const ignoredDirectories = new Set(['node_modules', '.git', 'data', 'logs', 'tmp']);
const files = [];

async function walk(directory) {
  const entries = await fs.readdir(directory);
  for (const entry of entries) {
    const fullPath = path.join(directory, entry);
    const relativeParts = path.relative(root, fullPath).split(path.sep);
    if (relativeParts.some((part) => ignoredDirectories.has(part))) continue;

    const stats = await fs.stat(fullPath);
    if (stats.isDirectory()) await walk(fullPath);
    else if (entry.endsWith('.js')) files.push(fullPath);
  }
}

(async () => {
  await walk(root);
  let failed = false;
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      failed = true;
      console.error(result.stderr || result.stdout);
    }
  }

  if (failed) process.exit(1);
  console.log(`Syntax check passed for ${files.length} JavaScript files.`);
})();
