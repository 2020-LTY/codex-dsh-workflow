import { cp, mkdir, rename, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../skills/dsh-delegate/', import.meta.url));
const parent = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills');
const target = join(parent, 'dsh-delegate');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--replace')) throw new Error('Usage: node scripts/install-skill.mjs [--replace]');
await mkdir(parent, { recursive: true });
let exists = false;
try { await access(target); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (exists && !args.includes('--replace')) throw new Error('Skill exists. Use --replace to back it up and replace.');
// 先完整复制再切换，避免复制失败破坏已有技能。
const temporary = join(parent, `.dsh-delegate-install-${Date.now()}`);
await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
let backup;
if (exists) {
  backup = `${target}.backup-${Date.now()}`;
  await rename(target, backup);
}
try { await rename(temporary, target); }
catch (error) { if (backup) await rename(backup, target); throw error; }
console.log(JSON.stringify({ installed: target, ...(backup ? { backup } : {}) }));
