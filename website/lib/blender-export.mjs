import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const executable = process.env.BLENDER_PATH || '/Applications/Blender.app/Contents/MacOS/Blender';
const script = fileURLToPath(new URL('../scripts/export-blender.py', import.meta.url));
const scratch = fileURLToPath(new URL('../.runtime/blender-exports/', import.meta.url));
let busy = false;
export async function blenderAvailable() { try { await access(executable); return true; } catch { return false; } }
function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
export function validateSceneGlb(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw fail('Invalid scene GLB');
  const size = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || 20 + size > bytes.length) throw fail('Invalid GLB JSON chunk');
  let document;
  try { document = JSON.parse(bytes.toString('utf8', 20, 20 + size)); } catch { throw fail('Invalid GLB JSON'); }
  if ([...(document.buffers || []), ...(document.images || [])].some(item => item.uri !== undefined)) throw fail('Scene must contain embedded resources only');
  if (document.asset?.version !== '2.0' || !document.scenes?.length) throw fail('GLB scene is missing');
}
export async function exportBlend(request, response) {
  // This endpoint only accepts explicit same-origin binary POSTs to loopback.
  if (!/^((localhost|127\.0\.0\.1)(:\d+)?)$/.test(request.headers.host || '') || (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)) throw fail('Local origin required', 403);
  if (request.headers['content-type'] !== 'model/gltf-binary') throw fail('Expected a binary GLB', 415);
  if (!await blenderAvailable()) throw fail('Blender is not installed on this local server', 503);
  if (busy) throw fail('Another Blender export is running', 409);
  busy = true;
  let directory;
  try {
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) throw fail('Scene exceeds 256 MB', 413);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    validateSceneGlb(bytes);
    await mkdir(scratch, { recursive: true });
    directory = await mkdtemp(path.join(scratch, 'scene-'));
    const input = path.join(directory, 'scene.glb');
    const output = path.join(directory, 'scene.blend');
    await writeFile(input, bytes);
    await new Promise((resolve, reject) => {
      const child = spawn(executable, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script, '--', input, output], { stdio: ['ignore', 'ignore', 'pipe'] });
      let diagnostics = '';
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(fail('Blender export timed out', 504)); }, 120_000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(fail(`Blender export failed (${code}): ${diagnostics}`, 500)); });
    });
    const result = await readFile(output);
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': result.length, 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="scene.blend"' });
    response.end(result);
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); busy = false; }
}
