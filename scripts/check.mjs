import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set(['.git', 'dist', 'node_modules']);
export async function sourceFiles(directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink not permitted: ${relative(root, path)}`);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else result.push(path);
  }
  return result.sort();
}
export async function check() {
  const files = await sourceFiles();
  const rules = [
    ['personal Windows home', /[A-Z]:[\\/]Users[\\/](?!Public\b|Default\b)[^\s"'<>/\\]+/i],
    ['personal Unix home', /(?:^|[\s"'`(])\/(?:home|Users)\/[a-z][a-z0-9_-]+\//im],
    ['GitHub token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['provider key', /\bsk-[A-Za-z0-9_-]{24,}\b/],
    ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ];
  for (const file of files) {
    const path = relative(root, file).replaceAll('\\', '/');
    if (/(^|\/)(?:\.env(?:\..*)?|endpoint\.json|ownership\.json|token(?:\..*)?|live-tests|\.compat)(\/|$)/.test(path)) throw new Error(`Private file excluded: ${path}`);
    const text = await readFile(file, 'utf8');
    for (const [label, rule] of rules) if (rule.test(text)) throw new Error(`Privacy rule '${label}' failed in ${path}`);
  }
  const skillPath = join(root, 'skills/dsh-delegate');
  const entry = await readFile(join(skillPath, 'SKILL.md'), 'utf8');
  if (!/^---\r?\nname: dsh-delegate\r?\ndescription:/m.test(entry)) throw new Error('Invalid skill frontmatter');
  for (const match of entry.matchAll(/\]\((references\/[^)]+)\)/g)) await readFile(join(skillPath, match[1].split('#')[0]));
  if (!(await readFile(join(root, 'plugin/scripts/client.mjs'))).equals(await readFile(join(skillPath, 'scripts/client.mjs')))) throw new Error('Skill client differs from plugin client');
  console.log(`Privacy and skill checks passed (${files.length} source files).`);
  return files;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await check();
