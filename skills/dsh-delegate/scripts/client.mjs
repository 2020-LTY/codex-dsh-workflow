import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 凭证仅从本机文件读取，不进入命令参数、标准输出或任务单。
const [method = 'GET', path = '/v1/health', payloadFile] = process.argv.slice(2);
const directory = process.env.DSH_CODEX_CONTROL_DIR ?? join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'codex-control');
const endpoint = JSON.parse(await readFile(join(directory, 'endpoint.json'), 'utf8'));
if (endpoint.protocol !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.origin) || !path.startsWith('/v1/')) throw new Error('invalid local endpoint');
const token = (await readFile(endpoint.tokenFile, 'utf8')).trim();
const body = payloadFile ? await readFile(payloadFile, 'utf8') : undefined;
const response = await fetch(endpoint.origin + path, { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body, signal: AbortSignal.timeout(30000) });
console.log(await response.text());
if (!response.ok) process.exitCode = 1;
