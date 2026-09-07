import { exportFilename } from './export-filename';
import type { ModelCatalogEntry } from '../src/App';
import { saveImportedModel } from './browser-models';

type ArchiveResult = { id: string; catalog: ModelCatalogEntry; modelId: string; files: Record<string, Uint8Array<ArrayBuffer>> };
function processArchive<T>(action: 'export' | 'import' | 'building' | 'scene', payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./address-archive.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { clearTimeout(timeout); worker.terminate(); };
    const timeout = setTimeout(() => { finish(); reject(new Error('Archive processing timed out')); }, 120_000);
    worker.onmessage = ({ data }) => { finish(); if (data.error) reject(new Error(data.error)); else resolve(data.result); };
    worker.onerror = event => { finish(); reject(new Error(event.message || 'Archive processing failed')); };
    worker.postMessage({ action, payload });
  });
}
export async function exportAddress(model: ModelCatalogEntry, includeBlender = false) {
  const filename = exportFilename(model, 'zip');
  const paths = { 'model.glb': model.modelPath, 'metadata.json': model.metadataPath, 'source-mesh.json': model.sourceMeshPath, ...(model.areaSurfacePath ? { 'area.json': model.areaSurfacePath } : {}), ...(model.buildingFacadePath ? { 'building-facade.glb': model.buildingFacadePath } : {}), ...(model.completeBlendPath ? { 'complete-facade.blend': model.completeBlendPath } : {}) };
  const entries = await Promise.all(Object.entries(paths).map(async ([name, path]) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Could not read ${name}`);
    return [name, new Uint8Array(await response.arrayBuffer())] as const;
  }));
  const files = Object.fromEntries(entries);
  if (includeBlender && files['area.json'] && !files['complete-facade.blend']) {
    const glb = await processArchive<Uint8Array<ArrayBuffer>>('scene', { glb: files['model.glb'].buffer, area: files['area.json'], format: 'glb' });
    files['complete-facade.blend'] = await convertToBlender(glb);
  }
  // Keep the original association when re-exporting an imported snapshot.
  const modelId = files['area.json'] ? JSON.parse(new TextDecoder().decode(files['area.json'])).modelId : model.archiveModelId ?? model.id;
  const bytes = await processArchive<Uint8Array<ArrayBuffer>>('export', { modelId, files });
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export async function importAddress(file: File) {
  if (file.size > 100 * 1024 * 1024) throw new Error('Choose a ZIP smaller than 100 MB');
  const result = await processArchive<ArchiveResult>('import', new Uint8Array(await file.arrayBuffer()));
  return await saveImportedModel(result) as unknown as ModelCatalogEntry;
}

export async function exportBuildingFacade(model: ModelCatalogEntry) {
  const filename = exportFilename(model, 'glb', 'building-facade');
  let bytes: Uint8Array<ArrayBuffer>;
  if (model.buildingFacadePath) {
    const response = await fetch(model.buildingFacadePath);
    if (!response.ok) throw new Error('Could not load the building facade GLB');
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    if (!model.areaSurfacePath) throw new Error('No facade data is available');
    const responses = await Promise.all([fetch(model.modelPath), fetch(model.areaSurfacePath)]);
    if (responses.some(response => !response.ok)) throw new Error('Could not load building data');
    const [glb, area] = await Promise.all(responses.map(response => response.arrayBuffer()));
    bytes = await processArchive<Uint8Array<ArrayBuffer>>('building', { glb, area: new Uint8Array(area) });
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function exportCompleteScene(model: ModelCatalogEntry, format: 'glb' | 'three' | 'blend') {
  const filename = exportFilename(model, format === 'three' ? 'three.json' : format, 'complete-facade');
  let bytes: Uint8Array<ArrayBuffer>;
  if (format === 'blend' && model.completeBlendPath) {
    const response = await fetch(model.completeBlendPath);
    if (!response.ok) throw new Error('Could not load the stored Blender scene');
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    if (!model.areaSurfacePath) throw new Error('No facade scene is available');
    const responses = await Promise.all([fetch(model.modelPath), fetch(model.areaSurfacePath)]);
    if (responses.some(response => !response.ok)) throw new Error('Could not load scene data');
    const [glb, area] = await Promise.all(responses.map(response => response.arrayBuffer()));
    bytes = await processArchive<Uint8Array<ArrayBuffer>>('scene', { glb, area: new Uint8Array(area), format: format === 'three' ? 'three' : 'glb' });
    if (format === 'blend') {
      bytes = await convertToBlender(bytes);
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: format === 'three' ? 'application/json' : 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function convertToBlender(bytes: Uint8Array<ArrayBuffer>) {
  const response = await fetch('/api/export/blend', { method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: bytes });
  if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Blender export failed'); }
  return new Uint8Array(await response.arrayBuffer());
}
