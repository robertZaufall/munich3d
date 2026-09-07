/** Use local download time for every export, preserving Unicode address names. */
export function exportFilename(model: { address: string; neighborDistance: number }, extension: string, kind = '', now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const address = model.address.replace(/[^\p{L}\p{N}._-]+/gu, '-');
  return `${address}-${model.neighborDistance}m${kind ? `-${kind}` : ''}-${timestamp}.${extension}`;
}
