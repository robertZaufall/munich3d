/// <reference lib="webworker" />

// @ts-expect-error The shared extractor is browser-compatible JavaScript.
import { extractBuildings } from '../../extract_buildings.mjs';
// @ts-expect-error The shared GLB builder is browser-compatible JavaScript.
import { buildGlb } from '../../export_model_to_glb.mjs';
// @ts-expect-error The catalog builder is shared with the Node server.
import { createCatalogEntry } from '../scripts/catalog-entry.mjs';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener('message', async (event) => {
  const { id, address, neighborDistance } = event.data as {
    id: string;
    address: string;
    neighborDistance: number;
  };
  try {
    const extraction = await extractBuildings({
      address,
      neighborDistance,
      includeObj: false,
    });
    const result = buildGlb(extraction.sourceMesh, extraction.metadata);
    const catalog = createCatalogEntry({
      id,
      metadata: extraction.metadata,
      modelPath: '',
      sourceMeshPath: '',
      metadataPath: '',
      runtime: true,
    });
    workerScope.postMessage(
      {
        catalog,
        glb: result.output.buffer,
        sourceMesh: `${JSON.stringify(extraction.sourceMesh, null, 2)}\n`,
        metadata: `${JSON.stringify(extraction.metadata, null, 2)}\n`,
      },
      [result.output.buffer],
    );
  } catch (error) {
    workerScope.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
