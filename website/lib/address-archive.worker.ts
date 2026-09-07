/// <reference lib="webworker" />
// @ts-expect-error Shared archive codec also runs in Node regression tests.
import { exportArchive, importArchive } from './address-archive.mjs';
import { buildBuildingFacade } from './building-facade-export';
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async ({ data }) => {
  try {
    if (data.action === 'building' || data.action === 'scene') {
      const result = await buildBuildingFacade(data.payload.glb, data.payload.area, data.action === 'scene' ? { complete: true, format: data.payload.format } : {});
      scope.postMessage({ result }, [result.buffer]);
    } else {
      if (data.action === 'export' && data.payload.files['area.json'] && !data.payload.files['building-facade.glb']) {
        data.payload.files['building-facade.glb'] = await buildBuildingFacade(data.payload.files['model.glb'].buffer, data.payload.files['area.json']);
      }
      scope.postMessage({ result: await (data.action === 'export' ? exportArchive(data.payload) : importArchive(data.payload)) });
    }
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : 'Invalid address archive' });
  }
};
