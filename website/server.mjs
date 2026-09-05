import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createCatalogEntry } from './scripts/catalog-entry.mjs';

const websiteDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.dirname(websiteDirectory);
const runtimeDirectory = path.join(websiteDirectory, '.runtime');
const modelCacheDirectory = path.join(runtimeDirectory, 'models');
const jobDirectory = path.join(runtimeDirectory, 'jobs');
const invalidDirectory = path.join(runtimeDirectory, 'invalid');
const production = process.argv.includes('--production');
const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
const runningJobs = new Map();
const neighborSelectionMode = 'complete_geometry_within_primary_distance';
const modelPipelineVersion = 4;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

await Promise.all([
  mkdir(modelCacheDirectory, { recursive: true }),
  mkdir(jobDirectory, { recursive: true }),
  mkdir(invalidDirectory, { recursive: true }),
]);

function sendJson(response, statusCode, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  response.end(body);
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16 * 1024) throw requestError('Request body is too large', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw requestError('Request body must be valid JSON');
  }
}

function validatedRequest(value) {
  const address = typeof value.address === 'string' ? value.address.trim() : '';
  const hasControlCharacter = [...address].some(
    (character) => character.codePointAt(0) < 32,
  );
  if (address.length < 3 || address.length > 300 || hasControlCharacter) {
    throw requestError('Address must contain between 3 and 300 printable characters');
  }
  const neighborDistance = Number(value.neighborDistance ?? 35);
  if (!Number.isFinite(neighborDistance) || neighborDistance < 0 || neighborDistance > 250) {
    throw requestError('Neighbor distance must be between 0 and 250 metres');
  }

  let coordinates = null;
  if (value.coordinates != null) {
    if (!Array.isArray(value.coordinates) || value.coordinates.length !== 2) {
      throw requestError('Coordinates must be [latitude, longitude]');
    }
    const latitude = Number(value.coordinates[0]);
    const longitude = Number(value.coordinates[1]);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw requestError('Coordinates are outside the valid latitude/longitude range');
    }
    coordinates = [latitude, longitude];
  }

  return { address, neighborDistance, coordinates };
}

function modelId(options) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ modelPipelineVersion, ...options }))
    .digest('hex')
    .slice(0, 16);
  return `local-${digest}`;
}

function runNode(script, arguments_, timeoutMilliseconds = 300_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...arguments_], {
      cwd: repositoryDirectory,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => `${current}${chunk}`.slice(-64_000);
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Generation timed out after ${timeoutMilliseconds / 1000} seconds`));
    }, timeoutMilliseconds);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const detail = (stderr || stdout).trim().split('\n').slice(-4).join('\n');
        reject(new Error(detail || `Generation process exited with code ${code}`));
      }
    });
  });
}

async function bundleFiles(directory) {
  const files = await readdir(directory);
  const sourceMesh = files.find((file) => file.endsWith('.source-mesh.json'));
  const metadata = files.find((file) => file.endsWith('.metadata.json'));
  const glb = files.includes('model.glb') ? 'model.glb' : null;
  if (!sourceMesh || !metadata || !glb) {
    throw new Error('Generated model bundle is incomplete');
  }
  return { sourceMesh, metadata, glb };
}

async function catalogEntryFor(id) {
  const directory = path.join(modelCacheDirectory, id);
  const files = await bundleFiles(directory);
  const metadata = JSON.parse(
    await readFile(path.join(directory, files.metadata), 'utf8'),
  );
  if (metadata.selection?.neighborSelectionMode !== neighborSelectionMode) {
    throw new Error('Runtime model uses an outdated neighbor-selection rule');
  }
  const expectedId = modelId({
    address: metadata.request?.address,
    neighborDistance: metadata.request?.neighborDistanceMetres,
    coordinates: metadata.request?.coordinatesOverride
      ? [
          metadata.request.coordinatesOverride.latitude,
          metadata.request.coordinatesOverride.longitude,
        ]
      : null,
  });
  if (id !== expectedId) {
    throw new Error('Runtime model uses an outdated pipeline version');
  }
  const basePath = `/api/model-files/${id}`;
  return createCatalogEntry({
    id,
    metadata,
    modelPath: `${basePath}/model.glb`,
    sourceMeshPath: `${basePath}/source-mesh.json`,
    metadataPath: `${basePath}/metadata.json`,
    runtime: true,
  });
}

async function cachedCatalog() {
  const entries = await readdir(modelCacheDirectory, { withFileTypes: true });
  const models = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^local-[a-f0-9]{16}$/u.test(entry.name)) continue;
    try {
      models.push(await catalogEntryFor(entry.name));
    } catch (error) {
      console.warn(`Ignoring incomplete runtime model ${entry.name}: ${error.message}`);
    }
  }
  return models.sort((left, right) =>
    left.address.localeCompare(right.address, 'de', { sensitivity: 'base' }),
  );
}

async function moveInvalidCache(id) {
  const directory = path.join(modelCacheDirectory, id);
  try {
    await access(directory);
  } catch {
    return;
  }
  await rename(
    directory,
    path.join(invalidDirectory, `${id}-${Date.now()}-${randomUUID().slice(0, 8)}`),
  );
}

async function generateModel(options, id) {
  try {
    return { model: await catalogEntryFor(id), cached: true };
  } catch {
    await moveInvalidCache(id);
  }

  const workingDirectory = await mkdtemp(path.join(jobDirectory, `${id}-`));
  const extractorArguments = [
    '--address',
    options.address,
    '--neighbor-distance',
    String(options.neighborDistance),
    '--output',
    workingDirectory,
  ];
  if (options.coordinates) {
    extractorArguments.push('--coordinates', options.coordinates.join(','));
  }

  await runNode(
    path.join(repositoryDirectory, 'extract_buildings.mjs'),
    extractorArguments,
  );
  const generatedFiles = await readdir(workingDirectory);
  const sourceMesh = generatedFiles.find((file) => file.endsWith('.source-mesh.json'));
  const metadata = generatedFiles.find((file) => file.endsWith('.metadata.json'));
  if (!sourceMesh || !metadata) throw new Error('Extractor output is incomplete');
  await runNode(path.join(repositoryDirectory, 'export_model_to_glb.mjs'), [
    path.join(workingDirectory, sourceMesh),
    path.join(workingDirectory, metadata),
    path.join(workingDirectory, 'model.glb'),
  ]);
  await Promise.all(
    generatedFiles
      .filter((file) => file === 'README.md' || file.endsWith('.obj'))
      .map((file) => rm(path.join(workingDirectory, file))),
  );
  await bundleFiles(workingDirectory);
  await rename(workingDirectory, path.join(modelCacheDirectory, id));
  return { model: await catalogEntryFor(id), cached: false };
}

async function requestedModel(options) {
  const id = modelId(options);
  if (!runningJobs.has(id)) {
    const job = generateModel(options, id).finally(() => runningJobs.delete(id));
    runningJobs.set(id, job);
  }
  return runningJobs.get(id);
}

async function deleteRuntimeModel(id) {
  if (runningJobs.has(id)) {
    throw requestError('Model generation is still in progress', 409);
  }
  const directory = path.join(modelCacheDirectory, id);
  try {
    await access(directory);
  } catch {
    throw requestError('Runtime model not found', 404);
  }
  try {
    await catalogEntryFor(id);
  } catch {
    throw requestError('Runtime model is not deletable', 409);
  }
  await rm(directory, { recursive: true });
  return { deletedId: id };
}

async function sendModelFile(response, id, requestedFile) {
  const directory = path.join(modelCacheDirectory, id);
  const files = await bundleFiles(directory);
  const mappings = {
    'model.glb': files.glb,
    'source-mesh.json': files.sourceMesh,
    'metadata.json': files.metadata,
  };
  const file = mappings[requestedFile];
  if (!file) throw requestError('Unknown model file', 404);
  const filePath = path.join(directory, file);
  const details = await stat(filePath);
  response.writeHead(200, {
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Type': requestedFile.endsWith('.json')
      ? 'application/json; charset=utf-8'
      : 'model/gltf-binary',
    'Content-Length': details.size,
  });
  createReadStream(filePath).pipe(response);
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/health' && request.method === 'GET') {
    sendJson(response, 200, { status: 'ok', generation: 'direct-node-glb' });
    return true;
  }
  if (url.pathname === '/api/models' && request.method === 'GET') {
    sendJson(response, 200, { models: await cachedCatalog() });
    return true;
  }
  if (url.pathname === '/api/models' && request.method === 'POST') {
    const options = validatedRequest(await readJsonBody(request));
    sendJson(response, 201, await requestedModel(options));
    return true;
  }
  const modelMatch = url.pathname.match(
    /^\/api\/models\/(local-[a-f0-9]{16})$/u,
  );
  if (modelMatch && request.method === 'DELETE') {
    sendJson(response, 200, await deleteRuntimeModel(modelMatch[1]));
    return true;
  }
  const fileMatch = url.pathname.match(
    /^\/api\/model-files\/(local-[a-f0-9]{16})\/(model\.glb|source-mesh\.json|metadata\.json)$/u,
  );
  if (fileMatch && request.method === 'GET') {
    await sendModelFile(response, fileMatch[1], fileMatch[2]);
    return true;
  }
  if (url.pathname.startsWith('/api/')) {
    throw requestError('API route not found', 404);
  }
  return false;
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
]);

async function serveProduction(response, url) {
  const distributionDirectory = path.join(websiteDirectory, 'dist');
  const decodedPath = decodeURIComponent(url.pathname);
  const requestedPath = path.resolve(
    distributionDirectory,
    `.${decodedPath === '/' ? '/index.html' : decodedPath}`,
  );
  const distributionPrefix = `${distributionDirectory}${path.sep}`;
  if (!requestedPath.startsWith(distributionPrefix)) {
    throw requestError('File not found', 404);
  }
  let filePath = requestedPath;
  try {
    if (!(await stat(filePath)).isFile()) throw new Error('Not a file');
  } catch {
    filePath = path.join(distributionDirectory, 'index.html');
  }
  const details = await stat(filePath);
  response.writeHead(200, {
    'Content-Type': contentTypes.get(path.extname(filePath)) ?? 'application/octet-stream',
    'Content-Length': details.size,
  });
  createReadStream(filePath).pipe(response);
}

const vite = production
  ? null
  : await import('vite').then(({ createServer: createViteServer }) =>
      createViteServer({
        root: websiteDirectory,
        server: { middlewareMode: true },
        appType: 'spa',
      }),
    );

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
    if (await handleApi(request, response, url)) return;
    if (vite) {
      vite.middlewares(request, response, (error) => {
        if (error && !response.headersSent) sendJson(response, 500, { error: error.message });
      });
    } else {
      await serveProduction(response, url);
    }
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    const statusCode = Number(error.statusCode) || 500;
    sendJson(response, statusCode, {
      error: statusCode >= 500 ? 'Model generation failed' : error.message,
      ...(statusCode >= 500 ? { detail: error.message } : {}),
    });
  }
});

server.listen(port, host, () => {
  console.log(
    `Munich3D ${production ? 'production' : 'development'} server: http://${host}:${port}/`,
  );
});

async function close() {
  await vite?.close();
  server.close();
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
