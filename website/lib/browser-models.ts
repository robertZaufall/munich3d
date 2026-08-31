const databaseName = 'munich3d-runtime-models';
const storeName = 'models';
const modelPipelineVersion = 3;

type CatalogEntry = {
  id: string;
  runtime: boolean;
  modelPath: string;
  sourceMeshPath: string;
  metadataPath: string;
  [key: string]: unknown;
};

type StoredModel = {
  id: string;
  catalog: CatalogEntry;
  glb: Blob;
  sourceMesh: Blob;
  metadata: Blob;
};

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error), { once: true });
  });
}

async function database() {
  const request = indexedDB.open(databaseName, 1);
  request.addEventListener('upgradeneeded', () => {
    if (!request.result.objectStoreNames.contains(storeName)) {
      request.result.createObjectStore(storeName, { keyPath: 'id' });
    }
  });
  return requestResult(request);
}

async function readModel(id: string) {
  const db = await database();
  const transaction = db.transaction(storeName, 'readonly');
  const completed = transactionComplete(transaction);
  const result = await requestResult<StoredModel | undefined>(
    transaction.objectStore(storeName).get(id),
  );
  await completed;
  db.close();
  return result;
}

async function writeModel(model: StoredModel) {
  const db = await database();
  const transaction = db.transaction(storeName, 'readwrite');
  const completed = transactionComplete(transaction);
  transaction.objectStore(storeName).put(model);
  await completed;
  db.close();
}

function hydrate(model: StoredModel): CatalogEntry {
  return {
    ...model.catalog,
    modelPath: URL.createObjectURL(model.glb),
    sourceMeshPath: URL.createObjectURL(model.sourceMesh),
    metadataPath: URL.createObjectURL(model.metadata),
  };
}

function generateInWorker(options: {
  id: string;
  address: string;
  neighborDistance: number;
}) {
  return new Promise<{
    catalog: CatalogEntry;
    glb: ArrayBuffer;
    sourceMesh: string;
    metadata: string;
  }>((resolve, reject) => {
    const worker = new Worker(
      new URL('./browser-generator.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.addEventListener('message', (event) => {
      worker.terminate();
      if (event.data?.error) reject(new Error(String(event.data.error)));
      else resolve(event.data);
    }, { once: true });
    worker.addEventListener('error', (event) => {
      worker.terminate();
      reject(new Error(event.message || 'Browser model generation failed'));
    }, { once: true });
    worker.postMessage(options);
  });
}

async function modelId(options: object) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ modelPipelineVersion, ...options }),
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = [...digest]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
  return `local-${hex}`;
}

export async function listBrowserModels() {
  const db = await database();
  const transaction = db.transaction(storeName, 'readonly');
  const completed = transactionComplete(transaction);
  const models = await requestResult<StoredModel[]>(
    transaction.objectStore(storeName).getAll(),
  );
  await completed;
  db.close();
  return models.map(hydrate);
}

export async function generateBrowserModel(options: {
  address: string;
  neighborDistance: number;
}) {
  const address = options.address.trim();
  let hasControlCharacter = false;
  for (const character of address) {
    if (character.codePointAt(0)! < 32) hasControlCharacter = true;
  }
  if (address.length < 3 || address.length > 300 || hasControlCharacter) {
    throw new Error('Address must contain between 3 and 300 printable characters');
  }
  if (
    !Number.isFinite(options.neighborDistance) ||
    options.neighborDistance < 0 ||
    options.neighborDistance > 250
  ) {
    throw new Error('Neighbor distance must be between 0 and 250 metres');
  }
  const normalized = {
    address,
    neighborDistance: options.neighborDistance,
    coordinates: null,
  };
  const id = await modelId(normalized);
  const cached = await readModel(id);
  if (cached) return { model: hydrate(cached), cached: true };

  const generated = await generateInWorker({
    id,
    address: normalized.address,
    neighborDistance: normalized.neighborDistance,
  });
  const stored: StoredModel = {
    id,
    catalog: generated.catalog,
    glb: new Blob([generated.glb], { type: 'model/gltf-binary' }),
    sourceMesh: new Blob([generated.sourceMesh], { type: 'application/json' }),
    metadata: new Blob([generated.metadata], { type: 'application/json' }),
  };
  await writeModel(stored);
  return { model: hydrate(stored), cached: false };
}

export async function deleteBrowserModel(id: string) {
  const db = await database();
  const transaction = db.transaction(storeName, 'readwrite');
  const completed = transactionComplete(transaction);
  transaction.objectStore(storeName).delete(id);
  await completed;
  db.close();
  return { deletedId: id };
}
