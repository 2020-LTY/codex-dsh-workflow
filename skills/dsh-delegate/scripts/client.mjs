import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 凭证仅从本机文件读取，不进入命令参数、标准输出或任务单。
export async function request(method, path, payload) {
  const directory = process.env.DSH_CODEX_CONTROL_DIR ?? join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'codex-control');
  const endpoint = JSON.parse(await readFile(join(directory, 'endpoint.json'), 'utf8'));
  if (endpoint.protocol !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.origin) || !path.startsWith('/v1/')) throw new Error('invalid local endpoint');
  const token = (await readFile(endpoint.tokenFile, 'utf8')).trim();
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const response = await fetch(endpoint.origin + path, { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body, signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error ?? `HTTP ${response.status}`), { status: response.status, response: value });
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [method = 'GET', path = '/v1/health', payloadFile] = process.argv.slice(2);
  try {
    const payload = payloadFile ? JSON.parse(await readFile(payloadFile, 'utf8')) : undefined;
    console.log(JSON.stringify(await request(method, path, payload)));
  } catch (error) {
    console.log(JSON.stringify(error.response ?? { error: error.message })); process.exitCode = 1;
  }
}
