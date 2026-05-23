const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('fs-extra');
const AdmZip = require('adm-zip');

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-_]{1,63}$/;

function getPluginManifest(pkg) {
  const manifest = pkg.modularDiscordBotPlugin || {};
  const id = manifest.id || pkg.name;
  const repository = normalizeRepositoryUrl(manifest.repository || pkg.repository);
  return {
    id,
    name: manifest.name || pkg.displayName || pkg.name,
    version: manifest.version || pkg.version || '0.0.0',
    description: manifest.description || pkg.description || '',
    author: manifest.author || normalizeAuthor(pkg.author),
    homepage: manifest.homepage || pkg.homepage || repository,
    repository,
    githubUrl: manifest.githubUrl || (repository?.includes('github.com') ? repository : null),
    keywords: manifest.keywords || pkg.keywords || [],
    entry: manifest.entry || pkg.main || 'index.js',
    requiresRestart: manifest.requiresRestart === true,
    permissions: manifest.permissions || [],
    defaultEnabled: manifest.defaultEnabled !== false
  };
}

function normalizeAuthor(author) {
  if (!author) return null;
  if (typeof author === 'string') return author;
  if (author.name && author.url) return `${author.name} (${author.url})`;
  return author.name || author.email || null;
}

function normalizeRepositoryUrl(repository) {
  if (!repository) return null;
  const raw = typeof repository === 'string' ? repository : repository.url;
  if (!raw) return null;
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
}

function assertSafePluginId(pluginId) {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error(`Invalid plugin id "${pluginId}". Use lowercase letters, numbers, hyphens, and underscores.`);
  }
}

async function validatePluginDirectory(pluginPath) {
  const packagePath = path.join(pluginPath, 'package.json');
  if (!(await fs.pathExists(packagePath))) {
    throw new Error('Plugin package.json was not found.');
  }

  const pkg = await fs.readJson(packagePath);
  const manifest = getPluginManifest(pkg);
  assertSafePluginId(manifest.id);

  const entryPath = path.resolve(pluginPath, manifest.entry);
  if (!entryPath.startsWith(path.resolve(pluginPath))) {
    throw new Error('Plugin entry path escapes the plugin directory.');
  }

  if (!(await fs.pathExists(entryPath))) {
    throw new Error(`Plugin entry "${manifest.entry}" was not found.`);
  }

  return { pkg, manifest, entryPath };
}

function isTrustedHost(sourceUrl, allowedHosts = []) {
  if (!allowedHosts.length) return true;
  const parsed = new URL(sourceUrl);
  return allowedHosts.includes(parsed.hostname.toLowerCase());
}

function isLikelyGitSource(sourceUrl) {
  return sourceUrl.endsWith('.git') || sourceUrl.includes('github.com/');
}

function runGitClone(sourceUrl, destination) {
  return new Promise((resolve, reject) => {
    const gitCommand = process.platform === 'win32' ? 'git.exe' : 'git';
    const child = spawn(gitCommand, ['clone', '--depth', '1', sourceUrl, destination], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone failed with code ${code}: ${stderr}`));
    });
  });
}

async function downloadArchive(sourceUrl, destination, maxBytes) {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to download plugin archive: ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength > maxBytes) {
    throw new Error(`Plugin archive is too large: ${contentLength} bytes`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Plugin archive is too large: ${bytes.byteLength} bytes`);
  }

  await fs.writeFile(destination, bytes);
}

async function extractZipSafely(zipPath, destination) {
  const zip = new AdmZip(zipPath);
  const root = path.resolve(destination);

  for (const entry of zip.getEntries()) {
    const resolved = path.resolve(destination, entry.entryName);
    if (!resolved.startsWith(root)) {
      throw new Error(`Unsafe archive entry detected: ${entry.entryName}`);
    }
  }

  zip.extractAllTo(destination, true);
}

async function findPluginRoot(directory, packagePath) {
  if (packagePath) {
    const explicit = path.resolve(directory, packagePath.replace(/\/package\.json$/, '').split('/').join(path.sep));
    if (await fs.pathExists(path.join(explicit, 'package.json'))) return explicit;
  }

  const directPackage = path.join(directory, 'package.json');
  if (await fs.pathExists(directPackage)) return directory;

  const entries = await fs.readdir(directory);
  for (const entry of entries) {
    const candidate = path.join(directory, entry);
    if ((await fs.stat(candidate)).isDirectory() && await fs.pathExists(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }

  throw new Error('Downloaded source did not contain a package.json at the root or first directory level.');
}

async function installPluginFromSource(source, options) {
  const {
    pluginsDirectory,
    allowedHosts = [],
    allowRemoteInstall = true,
    allowUntrusted = false,
    maxArchiveBytes = 50 * 1024 * 1024,
    overwrite = false,
    expectedPluginId = null,
    packagePath = null,
    logger
  } = options;

  if (!allowRemoteInstall) {
    throw new Error('Remote plugin installation is disabled by configuration.');
  }

  const sourceUrl = new URL(source);
  if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
    throw new Error('Only http and https plugin sources are supported.');
  }

  if (!allowUntrusted && !isTrustedHost(source, allowedHosts)) {
    throw new Error(`Plugin host "${sourceUrl.hostname}" is not in security.allowedPluginHosts.`);
  }

  const tempRoot = path.join(os.tmpdir(), `modular-discord-bot-${crypto.randomUUID()}`);
  const sourceDirectory = path.join(tempRoot, 'source');
  await fs.ensureDir(tempRoot);

  try {
    if (isLikelyGitSource(source)) {
      logger?.info('Cloning plugin repository', { source });
      await runGitClone(source, sourceDirectory);
    } else {
      logger?.info('Downloading plugin archive', { source });
      const archivePath = path.join(tempRoot, 'plugin.zip');
      await downloadArchive(source, archivePath, maxArchiveBytes);
      await fs.ensureDir(sourceDirectory);
      await extractZipSafely(archivePath, sourceDirectory);
    }

    const pluginRoot = await findPluginRoot(sourceDirectory, packagePath);
    const { manifest } = await validatePluginDirectory(pluginRoot);
    if (expectedPluginId && manifest.id !== expectedPluginId) {
      throw new Error(`Updated plugin id mismatch. Expected "${expectedPluginId}", got "${manifest.id}".`);
    }

    const destination = path.join(pluginsDirectory, manifest.id);

    if (!overwrite && await fs.pathExists(destination)) {
      throw new Error(`Plugin "${manifest.id}" is already installed.`);
    }

    await fs.ensureDir(pluginsDirectory);
    if (overwrite) await fs.remove(destination);
    await fs.copy(pluginRoot, destination, {
      filter: (src) => !src.includes(`${path.sep}.git${path.sep}`) && !src.endsWith(`${path.sep}.git`)
    });

    return { manifest, destination, source };
  } finally {
    await fs.remove(tempRoot);
  }
}

module.exports = {
  PLUGIN_ID_PATTERN,
  getPluginManifest,
  validatePluginDirectory,
  installPluginFromSource
};
