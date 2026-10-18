'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { handleRequest } = require('../dev/server.cjs');

async function request(url) {
  const result = {};
  await handleRequest({ url }, {
    writeHead(status, headers) { Object.assign(result, { status, headers }); return this; },
    end(body) { result.body = body; }
  });
  return result;
}

test('Local preview replaces production configuration in memory and blocks real data connections', async () => {
  const { status, headers, body } = await request('/');
  assert.equal(status, 200);
  assert.match(headers['Content-Security-Policy'], /connect-src 'none'/);
  assert.match(body, /<script src="\/__preview__\/mock-api.js"><\/script>/);
  assert.match(body, /const DEFAULT_SHEETS_URL = "\/__preview__\/api";/);
  assert.doesNotMatch(body, /script\.google\.com|PESADELO_PEDIDOS_UNB_PROD_V1|PESADELO_GESTAO_AUTH/);
  assert.match(body, /PRÉVIA LOCAL/);
  assert.equal((await request('/GoogleAppsScript_Database.js')).status, 404);
  assert.equal((await request('/__preview__/api')).status, 404, 'All fake API operations happen only inside the browser');
});

test('Preview API saves fictitious orders only in its separate browser storage', async () => {
  const storage = new Map([['PESADELO_PEDIDOS_UNB_PROD_V1', 'do not touch']]);
  const window = {};
  const localStorage = {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value)
  };
  const context = vm.createContext({ window, localStorage, location: { origin: 'http://127.0.0.1:4173' }, URL, Response });
  vm.runInContext(readFileSync(path.join(__dirname, '../dev/mock-api.js'), 'utf8'), context);
  const endpoint = '/__preview__/api';
  const get = async () => (await window.fetch(endpoint)).json();
  const post = async payload => (await window.fetch(endpoint, { method: 'POST', body: JSON.stringify(payload) })).json();
  assert.equal((await get()).orders.length, 0);
  assert.equal((await get()).comissarios.length, 2);
  await post({ action: 'addOrder', order: {
    id: 1, produto: 'Jersey (M) x1 [Nome: ANA; Número: 07]', quantidade: 1,
    valorTotal: 100, valorFormatado: 'R$ 100,00', itens: [{ produto: 'Jersey' }]
  } });
  let order = (await get()).orders[0];
  assert.match(order.produto, /Número: 07/);
  assert.equal(order.itens, undefined);
  assert.equal(order.valorTotal, 'R$ 100,00');
  await post({ action: 'updateOrder', id: 1, statusEntrega: 'Entregue' });
  order = (await get()).orders[0];
  assert.equal(order.statusEntrega, 'Entregue');
  await assert.rejects(window.fetch('https://script.google.com/macros/s/blocked/exec'), /bloqueou/);
  assert.equal(storage.get('PESADELO_PEDIDOS_UNB_PROD_V1'), 'do not touch');
  assert.equal(JSON.parse(storage.get('PESADELO_PREVIEW_DATABASE_V1')).orders.length, 1);
  await post({ action: 'deleteOrder', id: 1 });
  assert.equal((await get()).orders.length, 0);
});
