import type { ModelCatalogEntry } from '../src/App';
import { saveImportedModel } from './browser-models';

type ArchiveResult = { id: string; catalog: ModelCatalogEntry; modelId: string; files: Record<string, Uint8Array<ArrayBuffer>> };
function processArchive<T>(action: 'export' | 'import', payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./address-archive.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { clearTimeout(timeout); worker.terminate(); };
    const timeout = setTimeout(() => { finish(); reject(new Error('Archive processing timed out')); }, 120_000);
    worker.onmessage = ({ data }) => { finish(); if (data.error) reject(new Error(data.error)); else resolve(data.result); };
    worker.onerror = event => { finish(); reject(new Error(event.message || 'Archive processing failed')); };
    worker.postMessage({ action, payload });
  });
}
export async function exportAddress(model: ModelCatalogEntry) {
  const paths = { 'model.glb': model.modelPath, 'metadata.json': model.metadataPath, 'source-mesh.json': model.sourceMeshPath, ...(model.areaSurfacePath ? { 'area.json': model.areaSurfacePath } : {}) };
  const entries = await Promise.all(Object.entries(paths).map(async ([name, path]) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Could not read ${name}`);
    return [name, new Uint8Array(await response.arrayBuffer())] as const;
  }));
  const files = Object.fromEntries(entries);
  // Keep the original association when re-exporting an imported snapshot.
  const modelId = files['area.json'] ? JSON.parse(new TextDecoder().decode(files['area.json'])).modelId : model.archiveModelId ?? model.id;
  const bytes = await processArchive<Uint8Array<ArrayBuffer>>('export', { modelId, files });
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  link.download = `${model.address.replace(/[^\p{L}\p{N}._-]+/gu, '-')}-${model.neighborDistance}m-${timestamp}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export async function importAddress(file: File) {
  if (file.size > 100 * 1024 * 1024) throw new Error('Choose a ZIP smaller than 100 MB');
  const result = await processArchive<ArchiveResult>('import', new Uint8Array(await file.arrayBuffer()));
  return await saveImportedModel(result) as unknown as ModelCatalogEntry;
}
