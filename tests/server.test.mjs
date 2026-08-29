import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../server.mjs';

async function withServer(callback) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('health endpoint reports ok', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'obokmnie-strzeszyn' });
  });
});

test('serves the page and GeoJSON with correct content types', async () => {
  await withServer(async (origin) => {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(await page.text(), /Co budują/);

    const data = await fetch(`${origin}/data/strzeszyn-parcels.geojson`);
    assert.equal(data.status, 200);
    assert.match(data.headers.get('content-type'), /^application\/geo\+json/);
    assert.equal((await data.json()).features.length, 8);
  });
});

test('does not expose files outside public directory', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/..%2Fpackage.json`);
    assert.ok([403, 404].includes(response.status));
  });
});
