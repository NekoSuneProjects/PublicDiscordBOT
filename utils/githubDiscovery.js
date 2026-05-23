const DEFAULT_TOPIC = 'nekosunebot-package';
const GITHUB_API_VERSION = '2022-11-28';
const TOPIC_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/;

function clampLimit(value, fallback = 12) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), 50));
}

function normalizeTopic(topic) {
  const normalized = String(topic || DEFAULT_TOPIC).trim().toLowerCase();
  if (!TOPIC_PATTERN.test(normalized)) {
    throw new Error(`Invalid GitHub topic "${topic}".`);
  }
  return normalized;
}

function normalizeSort(sort) {
  const normalized = String(sort || 'stars').toLowerCase();
  if (['stars', 'forks', 'updated'].includes(normalized)) return normalized;
  return 'stars';
}

function normalizeOrder(order) {
  return String(order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
}

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'ModularDiscordBot-plugin-discovery'
  };

  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

function parseGithubRepositoryUrl(source) {
  const normalized = String(source || '')
    .trim()
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');

  const shorthand = normalized.match(/^github:([^/]+)\/(.+)$/i);
  if (shorthand) {
    return {
      owner: shorthand[1],
      repo: shorthand[2].replace(/\.git$/, '')
    };
  }

  const ssh = normalized.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (ssh) {
    return {
      owner: ssh[1],
      repo: ssh[2].replace(/\.git$/, '')
    };
  }

  let url;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }

  if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) return null;
  const [owner, repo] = url.pathname.split('/').filter(Boolean);
  if (!owner || !repo) return null;

  return {
    owner,
    repo: repo.replace(/\.git$/, '')
  };
}

function githubCloneUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`;
}

function githubHtmlUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}`;
}

async function githubJson(url) {
  const response = await fetch(url, {
    headers: githubHeaders()
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    const rateHint = remaining === '0' && reset
      ? ` GitHub rate limit resets at ${new Date(Number(reset) * 1000).toISOString()}.`
      : '';
    const error = new Error(`${payload.message || `GitHub request failed with status ${response.status}`}.${rateHint}`);
    error.status = response.status;
    throw error;
  }

  return payload;
}

function decodeGithubContent(file) {
  if (!file?.content) return null;
  return Buffer.from(file.content.replace(/\n/g, ''), file.encoding || 'base64').toString('utf8');
}

async function fetchPackageJsonAt(owner, repo, packagePath, ref) {
  const params = new URLSearchParams({ ref });
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${packagePath}?${params.toString()}`;
  const file = await githubJson(url);
  return JSON.parse(decodeGithubContent(file));
}

async function findRemotePackage(owner, repo, ref) {
  try {
    return {
      packagePath: 'package.json',
      pkg: await fetchPackageJsonAt(owner, repo, 'package.json', ref)
    };
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  const params = new URLSearchParams({ ref });
  const rootEntries = await githubJson(`https://api.github.com/repos/${owner}/${repo}/contents?${params.toString()}`);
  const directories = Array.isArray(rootEntries)
    ? rootEntries.filter((entry) => entry.type === 'dir').slice(0, 20)
    : [];

  for (const directory of directories) {
    try {
      const packagePath = `${directory.name}/package.json`;
      return {
        packagePath,
        pkg: await fetchPackageJsonAt(owner, repo, packagePath, ref)
      };
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  throw new Error(`No plugin package.json found in ${owner}/${repo}.`);
}

async function findRemotePluginPackages(owner, repo, ref) {
  const params = new URLSearchParams({ ref });
  const rootEntries = await githubJson(`https://api.github.com/repos/${owner}/${repo}/contents?${params.toString()}`);
  const packagePaths = ['package.json'];

  const directories = Array.isArray(rootEntries)
    ? rootEntries.filter((entry) => entry.type === 'dir').slice(0, 50)
    : [];

  for (const directory of directories) {
    packagePaths.push(`${directory.name}/package.json`);
  }

  const plugins = [];
  for (const packagePath of packagePaths) {
    try {
      const pkg = await fetchPackageJsonAt(owner, repo, packagePath, ref);
      const manifest = pluginManifestFromPackage(pkg, {
        owner,
        htmlUrl: githubHtmlUrl(owner, repo)
      });
      if (manifest.id) {
        plugins.push({ packagePath, package: pkg, manifest });
      }
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  return plugins;
}

function packageAuthor(author, fallback) {
  if (!author) return fallback;
  if (typeof author === 'string') return author;
  if (author.name && author.url) return `${author.name} (${author.url})`;
  return author.name || author.email || fallback;
}

function repositoryUrl(repository) {
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

function pluginManifestFromPackage(pkg, repository) {
  const manifest = pkg.modularDiscordBotPlugin || {};
  const repoUrl = repositoryUrl(manifest.repository || pkg.repository) || repository?.htmlUrl || null;
  return {
    id: manifest.id || pkg.name,
    name: manifest.name || pkg.displayName || pkg.name,
    version: manifest.version || pkg.version || '0.0.0',
    description: manifest.description || pkg.description || '',
    author: manifest.author || packageAuthor(pkg.author, repository?.owner),
    homepage: manifest.homepage || pkg.homepage || repoUrl,
    repository: repoUrl,
    githubUrl: repoUrl?.includes('github.com') ? repoUrl : repository?.htmlUrl || null,
    keywords: manifest.keywords || pkg.keywords || [],
    permissions: manifest.permissions || [],
    requiresRestart: manifest.requiresRestart === true
  };
}

async function getGithubRepositoryInfo(source) {
  const parsed = parseGithubRepositoryUrl(source);
  if (!parsed) return null;

  const repository = await githubJson(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`);
  return {
    owner: repository.owner?.login || parsed.owner,
    repo: repository.name || parsed.repo,
    fullName: repository.full_name || `${parsed.owner}/${parsed.repo}`,
    htmlUrl: repository.html_url || githubHtmlUrl(parsed.owner, parsed.repo),
    cloneUrl: repository.clone_url || githubCloneUrl(parsed.owner, parsed.repo),
    defaultBranch: repository.default_branch || 'main',
    description: repository.description,
    stars: repository.stargazers_count,
    forks: repository.forks_count,
    topics: repository.topics || [],
    language: repository.language,
    license: repository.license?.spdx_id || null,
    updatedAt: repository.updated_at,
    pushedAt: repository.pushed_at
  };
}

async function getGithubRemotePluginInfo(source, packagePath) {
  const repository = await getGithubRepositoryInfo(source);
  if (!repository) {
    throw new Error('Plugin source is not a GitHub repository URL.');
  }

  const resolved = packagePath
    ? {
      packagePath,
      pkg: await fetchPackageJsonAt(repository.owner, repository.repo, packagePath, repository.defaultBranch)
    }
    : await findRemotePackage(repository.owner, repository.repo, repository.defaultBranch);

  return {
    repository,
    packagePath: resolved.packagePath,
    package: resolved.pkg,
    manifest: pluginManifestFromPackage(resolved.pkg, repository)
  };
}

async function listGithubRemotePlugins(source) {
  const repository = await getGithubRepositoryInfo(source);
  if (!repository) {
    throw new Error('Plugin source is not a GitHub repository URL.');
  }

  const plugins = await findRemotePluginPackages(repository.owner, repository.repo, repository.defaultBranch);
  return {
    repository,
    plugins
  };
}

function buildRepositorySearchQuery({ topic, query }) {
  const parts = [
    `topic:${normalizeTopic(topic)}`,
    'archived:false'
  ];

  const extraQuery = String(query || '').trim();
  if (extraQuery) parts.push(extraQuery);

  return parts.join(' ');
}

function mapRepository(item) {
  return {
    id: item.id,
    fullName: item.full_name,
    name: item.name,
    owner: item.owner?.login,
    description: item.description,
    htmlUrl: item.html_url,
    cloneUrl: item.clone_url,
    author: item.owner?.login,
    githubUrl: item.html_url,
    defaultBranch: item.default_branch,
    stars: item.stargazers_count,
    forks: item.forks_count,
    openIssues: item.open_issues_count,
    language: item.language,
    topics: item.topics || [],
    license: item.license?.spdx_id || null,
    updatedAt: item.updated_at,
    pushedAt: item.pushed_at
  };
}

async function enrichRepository(repository) {
  try {
    const remoteList = await listGithubRemotePlugins(repository.cloneUrl);
    const primary = remoteList.plugins[0];
    return {
      ...repository,
      pluginId: primary?.manifest.id,
      pluginName: primary?.manifest.name,
      pluginVersion: primary?.manifest.version,
      pluginDescription: primary?.manifest.description || repository.description,
      author: primary?.manifest.author || repository.author,
      homepage: primary?.manifest.homepage,
      repository: primary?.manifest.repository,
      githubUrl: primary?.manifest.githubUrl || repository.githubUrl,
      packagePath: primary?.packagePath,
      permissions: primary?.manifest.permissions,
      requiresRestart: primary?.manifest.requiresRestart,
      pluginPackages: remoteList.plugins.map((entry) => ({
        pluginId: entry.manifest.id,
        pluginName: entry.manifest.name,
        pluginVersion: entry.manifest.version,
        pluginDescription: entry.manifest.description,
        packagePath: entry.packagePath
      })),
      packageReadable: true
    };
  } catch (error) {
    return {
      ...repository,
      packageReadable: false,
      packageError: error.message
    };
  }
}

async function searchGithubPluginRepositories(options = {}) {
  const limit = clampLimit(options.limit, options.defaultLimit || 12);
  const query = buildRepositorySearchQuery(options);
  const params = new URLSearchParams({
    q: query,
    sort: normalizeSort(options.sort),
    order: normalizeOrder(options.order),
    per_page: String(limit)
  });

  const response = await fetch(`https://api.github.com/search/repositories?${params.toString()}`, {
    headers: githubHeaders()
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    const rateHint = remaining === '0' && reset
      ? ` GitHub rate limit resets at ${new Date(Number(reset) * 1000).toISOString()}.`
      : '';
    throw new Error(`${payload.message || `GitHub search failed with status ${response.status}`}.${rateHint}`);
  }

  const repositories = (payload.items || []).map(mapRepository);
  const enriched = options.includePackageInfo === false
    ? repositories
    : await Promise.all(repositories.map(enrichRepository));

  return {
    topic: normalizeTopic(options.topic),
    query,
    totalCount: payload.total_count || 0,
    incompleteResults: payload.incomplete_results === true,
    repositories: enriched
  };
}

module.exports = {
  DEFAULT_TOPIC,
  parseGithubRepositoryUrl,
  getGithubRepositoryInfo,
  getGithubRemotePluginInfo,
  listGithubRemotePlugins,
  searchGithubPluginRepositories
};
