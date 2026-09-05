import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { buildGlb } from '../../export_model_to_glb.mjs';
import { createCatalogEntry } from '../scripts/catalog-entry.mjs';

export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_CONTENT_BYTES = 256 * 1024 * 1024;
const required = ['model.glb', 'metadata.json', 'source-mesh.json'];
const allowed = new Set(['manifest.json', ...required, 'area.json']);
const json = bytes => JSON.parse(strFromU8(bytes));
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');

export async function exportArchive({ modelId, files }) {
  const checksums = {};
  let total = 0;
  for (const [name, bytes] of Object.entries(files)) {
    if (!allowed.has(name) || name === 'manifest.json') throw new Error('Unexpected archive file');
    total += bytes.length;
    checksums[name] = await hash(bytes);
  }
  if (required.some(name => !files[name]) || total > MAX_CONTENT_BYTES) throw new Error('Incomplete or oversized address bundle');
  const manifest = { format: 'munich3d-address', version: 1, modelId, checksums,
    attribution: 'Bayerische Vermessungsverwaltung – www.geodaten.bayern.de (CC BY 4.0). Area data: OpenStreetMap contributors (ODbL), where included.' };
  const archive = zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)) }, { level: 6 });
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('ZIP exceeds the 100 MB limit');
  return archive;
}

export async function importArchive(archive) {
  if (!archive.length || archive.length > MAX_ARCHIVE_BYTES) throw new Error('Choose a ZIP smaller than 100 MB');
  let total = 0;
  const names = new Set();
  const files = unzipSync(archive, { filter: entry => {
    if (!allowed.has(entry.name) || names.has(entry.name)) throw new Error('ZIP contains unexpected or duplicate files');
    names.add(entry.name);
    total += entry.originalSize;
    if (total > MAX_CONTENT_BYTES) throw new Error('Unpacked ZIP exceeds the 256 MB limit');
    return true;
  } });
  if (!files['manifest.json'] || required.some(name => !files[name])) throw new Error('ZIP is missing required address files');
  const manifest = json(files['manifest.json']);
  if (manifest.format !== 'munich3d-address' || manifest.version !== 1 || typeof manifest.modelId !== 'string') throw new Error('Unsupported address archive format');
  for (const [name, bytes] of Object.entries(files)) {
    if (name !== 'manifest.json' && await hash(bytes) !== manifest.checksums?.[name]) throw new Error(`Damaged archive file: ${name}`);
  }
  const metadata = json(files['metadata.json']);
  const source = json(files['source-mesh.json']);
  // Reuse the canonical validator; retain the supplied source GLB unchanged.
  buildGlb(source, metadata);
  const glb = files['model.glb'];
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.length < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== glb.length || view.getUint32(16, true) !== 0x4e4f534a) throw new Error('Invalid model GLB');
  const scene = json(glb.subarray(20, 20 + view.getUint32(12, true)));
  if ([...(scene.buffers ?? []), ...(scene.images ?? [])].some(item => item.uri)) throw new Error('The model must be self-contained');
  const nodes = (scene.nodes ?? []).filter(node => node.extras?.role);
  if (nodes.length !== metadata.buildings.length || metadata.buildings.some(b => !nodes.some(n => n.extras.role === b.role && n.extras.gml_id === b.attributes?.gml_id))) throw new Error('GLB features do not match the source metadata');
  const identity = strToU8(JSON.stringify(Object.keys(files).filter(name => name !== 'manifest.json').sort().map(name => [name, manifest.checksums[name]])));
  const id = `import-${(await hash(identity)).slice(0, 24)}`;
  const catalog = createCatalogEntry({ id, metadata, modelPath: '', metadataPath: '', sourceMeshPath: '', runtime: true });
  catalog.imported = true;
  catalog.archiveModelId = manifest.modelId;
  if (typeof catalog.sourceUrl !== 'string' || !/^https:\/\//u.test(catalog.sourceUrl)) throw new Error('Invalid source reference URL');
  if (files['area.json']) {
    const area = json(files['area.json']);
    if (area.modelId !== manifest.modelId || !['generic', 'gothic'].includes(area.architectureStyle) || !Array.isArray(area.bounds) || area.bounds.length !== 4 || !area.bounds.every(Number.isFinite) || ['surfaces', 'lines', 'points', 'anchors'].some(key => !Array.isArray(area[key]))) throw new Error('Invalid façade or surface snapshot');
    catalog.architectureStyle = area.architectureStyle;
  }
  return { id, catalog, files, modelId: manifest.modelId };
}
