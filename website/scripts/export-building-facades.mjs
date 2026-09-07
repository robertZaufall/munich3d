import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { REVISION } from 'three';
import { discoverAddressBundles, listIfPresent } from './address-bundles.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let exporterPromise;
export function loadFacadeExporter() {
  return exporterPromise ??= (async () => {
    // GLTFExporter needs this FileReader method when run by the Node catalog job.
    globalThis.FileReader ??= class {
      readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }); }
    };
    const scratch = path.join(root, '.runtime', 'facade-export-code');
    await fs.mkdir(scratch, { recursive: true });
    for (const name of ['area-reconstruction', 'building-facade-export']) {
      const source = (await fs.readFile(path.join(root, `lib/${name}.ts`), 'utf8'))
        .replaceAll('import.meta.env.BASE_URL', JSON.stringify('/'))
        .replace("'./area-reconstruction'", "'./area-reconstruction.mjs'");
      await fs.writeFile(path.join(scratch, `${name}.mjs`), ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText);
    }
    return (await import(pathToFileURL(path.join(scratch, 'building-facade-export.mjs')))).buildBuildingFacade;
  })();
}

export async function ensureBuildingFacade(bundle, areaPath) {
  const [source, area, exporterCode, reconstructionCode] = await Promise.all([
    fs.readFile(path.join(bundle.modelDirectory, `${bundle.id}.glb`)),
    fs.readFile(areaPath),
    fs.readFile(path.join(root, 'lib/building-facade-export.ts')),
    fs.readFile(path.join(root, 'lib/area-reconstruction.ts')),
  ]);
  const fingerprint = {
    schemaVersion: 1, modelId: bundle.id,
    sourceGlbSha256: hash(source), areaSha256: hash(area),
    exporterSha256: hash(Buffer.concat([exporterCode, reconstructionCode, Buffer.from(REVISION)])),
  };
  const directory = path.join(bundle.directory, 'reconstruction');
  const stem = `${bundle.id}.building-facade`;
  const glbPath = path.join(directory, `${stem}.glb`);
  const manifestPath = path.join(directory, `${stem}.json`);
  let reusable = false;
  try {
    const previous = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    reusable = Object.entries(fingerprint).every(([key, value]) => previous[key] === value)
      && previous.glbSha256 === hash(await fs.readFile(glbPath));
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  if (!reusable) {
    const build = await loadFacadeExporter();
    const bytes = await build(source.buffer.slice(source.byteOffset, source.byteOffset + source.length), new Uint8Array(area));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(glbPath, bytes);
    await fs.writeFile(manifestPath, `${JSON.stringify({ ...fingerprint, glbSha256: hash(bytes) }, null, 2)}\n`);
    console.log(`Baked main-building facade: ${bundle.id}`);
  }
  return `${bundle.assetBase}/reconstruction/${stem}.glb`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selected = process.argv[2] ?? '--all';
  const bundles = (await discoverAddressBundles()).filter(bundle => selected === '--all' || selected === bundle.id);
  if (!bundles.length) throw new Error('No matching address bundle');
  for (const bundle of bundles) {
    for (const name of await listIfPresent(path.join(bundle.directory, 'area'))) {
      if (!name.endsWith('.json')) continue;
      const areaPath = path.join(bundle.directory, 'area', name);
      if (JSON.parse(await fs.readFile(areaPath, 'utf8')).modelId === bundle.id) await ensureBuildingFacade(bundle, areaPath);
    }
  }
}
