const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('fs-extra');

function packageDirectoryName(packageName) {
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/');
    return path.join(scope, name);
  }
  return packageName;
}

async function dependencyIsInstalled(pluginPath, dependencyName) {
  const packagePath = path.join(pluginPath, 'node_modules', packageDirectoryName(dependencyName));
  return fs.pathExists(packagePath);
}

function runNpmInstall(pluginPath, options, logger) {
  return new Promise((resolve, reject) => {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = ['install', '--no-audit', '--no-fund'];
    if (options.omitDev !== false) args.push('--omit=dev');
    if (options.ignoreScripts !== false) args.push('--ignore-scripts');

    const child = spawn(npmCommand, args, {
      cwd: pluginPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`npm install timed out after ${options.timeoutMs || 120000}ms`));
    }, options.timeoutMs || 120000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        if (stdout.trim()) logger?.debug('Plugin dependency install output', { stdout: stdout.trim() });
        resolve();
      } else {
        reject(new Error(`npm install failed with code ${code}: ${stderr || stdout}`));
      }
    });
  });
}

async function installPluginDependencies(pluginPath, options = {}, logger) {
  const packagePath = path.join(pluginPath, 'package.json');
  const pkg = await fs.readJson(packagePath);
  const dependencies = Object.keys(pkg.dependencies || {});
  if (!dependencies.length) return { installed: false, reason: 'no dependencies' };

  const missing = [];
  if (options.force === true) {
    missing.push(...dependencies);
  } else {
    for (const dependency of dependencies) {
      if (!(await dependencyIsInstalled(pluginPath, dependency))) {
        missing.push(dependency);
      }
    }
  }

  if (!missing.length) return { installed: false, reason: 'dependencies already installed' };

  logger?.info('Installing plugin dependencies', {
    pluginPath,
    dependencies: missing,
    force: options.force === true,
    ignoreScripts: options.ignoreScripts !== false
  });

  await runNpmInstall(pluginPath, options, logger);
  return { installed: true, dependencies: missing };
}

module.exports = {
  installPluginDependencies
};
