/// <reference lib="webworker" />
// @ts-expect-error Shared archive codec also runs in Node regression tests.
import { exportArchive, importArchive } from './address-archive.mjs';
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async ({ data }) => {
  try {
    scope.postMessage({ result: await (data.action === 'export' ? exportArchive(data.payload) : importArchive(data.payload)) });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : 'Invalid address archive' });
  }
};
