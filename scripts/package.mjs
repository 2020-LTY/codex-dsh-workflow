import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { root, check } from './check.mjs';

const files = await check();
const dist = join(root, 'dist');
await mkdir(dist, { recursive: true });
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
// npm 在 Windows 上通过当前 Node 的 npm-cli 入口启动，避免 shell 拼接。
const npmCli = process.env.npm_execpath;
let packed;
if (npmCli) packed = execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', dist], { cwd: join(root, 'plugin'), encoding: 'utf8' });
else throw new Error('Run packaging through npm run pack.');
const pkg = JSON.parse(packed)[0];
for (const file of pkg.files) if (!/^(src\/|scripts\/client\.mjs$|README\.md$|LICENSE$|package\.json$|cordis\.patch\.yml$)/.test(file.path)) throw new Error(`Unexpected plugin file: ${file.path}`);
// 使用 ZIP 的 STORE 格式，无外部依赖；源码体积小，不需要压缩。
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const parts = [], central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(`codex-dsh-workflow-${version}/${relative(root, file).replaceAll('\\', '/')}`);
  const data = await readFile(file);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x800, 8);
  header.writeUInt16LE(33, 14); header.writeUInt32LE(crc, 16); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
  parts.push(local, name, data); central.push(header, name); offset += local.length + name.length + data.length;
}
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(central.reduce((n, b) => n + b.length, 0), 12); end.writeUInt32LE(offset, 16);
const zipName = `codex-dsh-workflow-${version}.zip`;
await writeFile(join(dist, zipName), Buffer.concat([...parts, ...central, end]));
const hashes = [];
for (const name of [pkg.filename, zipName]) hashes.push(`${createHash('sha256').update(await readFile(join(dist, name))).digest('hex')}  ${name}`);
await writeFile(join(dist, 'SHA256SUMS'), hashes.join('\n') + '\n');
console.log(`Built ${pkg.filename}, ${zipName}, SHA256SUMS`);
