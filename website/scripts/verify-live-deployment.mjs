import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const base = 'https://glaubi.net/munich3d/';
const directory = new URL('../dist/cloudflare/munich3d/', import.meta.url);
const html = await readFile(new URL('index.html', directory), 'utf8');
const assets = [...html.matchAll(/(?:src|href)="(\/munich3d\/[^"?#]+\.(?:js|css))"/g)].map(match => match[1]);
if (!assets.length) throw new Error('No built entry assets found.');
const sample = 'addresses/muenchner-rathaus/model/muenchner-rathaus-100m.metadata.json';
const paths = ['index.html', ...assets.map(asset => asset.slice('/munich3d/'.length)), sample];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = new Map(await Promise.all(paths.map(async name => [name, digest(await readFile(new URL(name, directory)))])));
let failure;
for (let attempt = 1; attempt <= 10; attempt++) {
  try {
    for (const [name, hash] of expected) {
      const url = new URL(name === 'index.html' ? '' : name, base);
      url.searchParams.set('verify', `${process.env.GITHUB_SHA ?? 'local'}-${attempt}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
      if (!response.ok || digest(Buffer.from(await response.arrayBuffer())) !== hash) {
        throw new Error(`Live file does not match this build: ${name} (HTTP ${response.status})`);
      }
    }
    console.log(`Verified ${expected.size} live files against this build at ${base}`);
    process.exit(0);
  } catch (error) {
    failure = error;
    console.log(`Verification attempt ${attempt}/10: ${error.message}`);
    if (attempt < 10) await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
throw failure;
