/*
 * Run: node --test tests/catalog-checkout.test.cjs
 * These tests execute the real inline frontend and Apps Script in isolated VMs.
 * No browser, HTTP request, Google account or real spreadsheet is involved.
 */
'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectDir = path.resolve(__dirname, '..');
const html = readFileSync(path.join(projectDir, 'index.html'), 'utf8');
const frontendSource = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((match) => !/\bsrc\s*=/.test(match[1]))
  .map((match) => match[2]).join('\n');
const backendSource = readFileSync(path.join(projectDir, 'GoogleAppsScript_Database.js'), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));

function makeElement(id = '') {
  const classes = new Set();
  return {
    id, value: '', innerText: '', textContent: '', innerHTML: '', children: [],
    style: {}, dataset: {}, attributes: {}, disabled: false, hidden: false,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      }
    },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    removeAttribute(name) { delete this.attributes[name]; },
    setCustomValidity(message) { this.validationMessage = message; },
    reportValidity() { return !this.validationMessage; },
    checkValidity() { return !this.validationMessage; },
    addEventListener() {}, focus() {}, scrollIntoView() {}, reset() {}
  };
}

function makeStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function createFrontend() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const products = new Map(['Oversize', 'Jersey', 'Tube Top', 'Caneca', 'Caneca individual', 'Tirante individual', 'Corta Vento', 'Eco Bag']
    .map((product) => {
      const tile = makeElement();
      tile.dataset.product = product;
      tile.setAttribute('onclick', `selectProduct('${product}', this)`);
      return [product, tile];
    }));
  const sizes = new Map(['PP', 'P', 'M', 'G', 'GG', 'XGG'].map((size) => {
    const button = makeElement();
    button.innerText = button.textContent = size;
    button.setAttribute('onclick', `selectSize('${size}', this)`);
    return [size, button];
  }));
  const queryAll = (selector) => selector === '.product-tile' ? [...products.values()]
    : selector === '.size-btn' ? [...sizes.values()] : [];
  let exported = null;
  let networkAttempts = 0;
  const context = vm.createContext({
    console, localStorage: makeStorage(), sessionStorage: makeStorage(),
    document: {
      getElementById: element,
      querySelectorAll: queryAll,
      querySelector: (selector) => queryAll(selector)[0] || null,
      createElement: () => makeElement(),
      addEventListener() {},
      body: makeElement('body')
    },
    // Startup callbacks intentionally remain dormant: they normally sync the API.
    window: { addEventListener() {}, scrollTo() {} },
    navigator: {}, setTimeout: () => 0, clearTimeout() {},
    fetch() {
      networkAttempts += 1;
      throw new Error('Network disabled: isolated tests must never reach production');
    },
    XLSX: {
      utils: {
        book_new: () => ({ sheets: {} }),
        aoa_to_sheet: (rows) => clone(rows),
        book_append_sheet: (book, sheet, name) => { book.sheets[name] = sheet; }
      },
      writeFile: (book, filename) => { exported = { book: clone(book), filename }; }
    }
  });
  vm.runInContext(frontendSource, context, { filename: 'index.html:inline', timeout: 1000 });
  element('f_produto').value = 'Oversize';
  element('f_tamanho').value = 'M';
  element('f_quantidade').value = '1';
  const read = (expression) => clone(vm.runInContext(expression, context));
  const set = (name, value) => {
    context.__testValue = clone(value);
    vm.runInContext(`${name} = __testValue`, context);
    delete context.__testValue;
  };
  function configure(product, options = {}) {
    context.selectProduct(product, products.get(product));
    if (options.size) context.selectSize(options.size, sizes.get(options.size));
    element('f_quantidade').value = String(options.quantity ?? 1);
    if (product === 'Jersey') {
      element('f_jersey_nome').value = options.name ?? '';
      element('f_jersey_numero').value = options.number ?? '';
    }
  }
  function add(product, options) {
    configure(product, options);
    context.addItemToOrder();
  }
  function checkout() {
    element('f_nome').value = 'Comprador de teste local';
    element('f_telefone').value = '(61) 99999-9999';
    element('f_cpf').value = '000.000.000-00';
    element('f_comissario').value = 'Comissário local';
    set('currentUploadedFile', { nome: 'local.txt', type: 'text/plain', base64: 'dGVzdGU=' });
    context.handleOrderSubmit({ preventDefault() {} });
    return read('pendingOrderData');
  }
  return {
    context, element, products, sizes, read, set, configure, add, checkout,
    exported: () => exported,
    networkAttempts: () => networkAttempts
  };
}

const HEADERS = ['ID', 'Data', 'Nome', 'Telefone', 'CPF', 'Comissário', 'Produto', 'Tamanho', 'Quantidade', 'Status Pagamento', 'Status Entrega', 'Comprovante', 'Valor Total'];
const LEGACY_ROW = ['legacy-local', '01/01/2025 10:00', 'Legado local', '', '', 'Comissário local', 'Caneca', '-', 1, 'Confirmado', 'Pendente', '', 'R$ 42,00'];

function createMemoryBackend() {
  const rows = [clone(HEADERS), clone(LEGACY_ROW)];
  const comissarios = [['Nome'], ['Comissário local']];
  let appended = 0;
  let files = 0;
  let locks = 0;
  const forbidMutation = () => { throw new Error('Unexpected schema or pre-existing row mutation'); };
  const sheet = (values, allowAppend) => ({
    getLastColumn: () => values[0].length,
    getDataRange: () => ({ getValues: () => clone(values) }),
    appendRow(row) {
      assert.ok(allowAppend, 'Only the fake new-order sheet permits appends');
      assert.equal(row.length, 13, 'The existing order contract has exactly 13 columns');
      values.push(clone(row));
      appended += 1;
    },
    getRange: forbidMutation, deleteRow: forbidMutation, setFrozenRows: forbidMutation
  });
  const sheets = { Pedidos: sheet(rows, true), Comissarios: sheet(comissarios, false) };
  const folder = {
    createFile(blob) {
      assert.ok(blob.name.startsWith('Comprovante_'));
      files += 1;
      return { setSharing() {}, getUrl: () => `https://example.invalid/mock-receipt/${files}` };
    }
  };
  const context = vm.createContext({
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (name) => sheets[name], insertSheet: forbidMutation })
    },
    DriveApp: {
      getFoldersByName: () => ({ hasNext: () => true, next: () => folder }),
      createFolder: forbidMutation,
      Access: { ANYONE_WITH_LINK: 'mock' }, Permission: { VIEW: 'mock' }
    },
    Utilities: {
      base64Decode: (value) => [...Buffer.from(value, 'base64')],
      newBlob: (bytes, mime, name) => ({ bytes, mime, name })
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (content) => ({ content, setMimeType() { return this; } })
    },
    LockService: {
      getScriptLock: () => ({ tryLock() { locks += 1; return true; }, releaseLock() { locks -= 1; } })
    },
    Logger: { log() {} }
  });
  vm.runInContext(backendSource, context, { filename: 'GoogleAppsScript_Database.js:memory-only', timeout: 1000 });
  return {
    add(order) {
      const response = context.doPost({ postData: { contents: JSON.stringify({ action: 'addOrder', order }) } });
      const result = JSON.parse(response.content);
      assert.equal(result.status, 'success', result.error);
      assert.equal(locks, 0);
      return result;
    },
    get: () => JSON.parse(context.doGet({}).content),
    rows, appended: () => appended, files: () => files
  };
}

test('Cart prices remain consistent through checkout and the unchanged backend', async (t) => {
  const scenarios = [
    { name: 'A: individual mug + strap', items: [['Caneca individual', 1], ['Tirante individual', 1]], total: 50 },
    { name: 'B: existing combo', items: [['Caneca', 1]], total: 45 },
    { name: 'C: two individual mugs + strap', items: [['Caneca individual', 2], ['Tirante individual', 1]], total: 85 },
    { name: 'Corta Vento: two units at 180 each', items: [['Corta Vento', 2]], total: 360 }
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const app = createFrontend();
      for (const [product, quantity] of scenario.items) app.add(product, { quantity });
      const cart = app.read('orderCart');
      assert.equal(cart.reduce((sum, item) => sum + item.subtotal, 0), scenario.total);
      assert.ok(cart.every((item) => item.tamanho === (item.produto === 'Corta Vento' ? 'M' : '-')));
      assert.equal(app.element('pixTotalValueDisplay').innerText, `R$ ${scenario.total},00`);
      const order = app.checkout();
      assert.equal(order.valorTotal, scenario.total);
      assert.equal(order.valorFormatado, `R$ ${scenario.total},00`);
      const backend = createMemoryBackend();
      backend.add(order);
      const loaded = backend.get().orders.find((item) => item.id === order.id);
      assert.equal(loaded.valorTotal, order.valorFormatado);
      assert.equal(loaded.produto, order.produto);
      assert.equal(loaded.itens, undefined, 'The real backend persists the existing textual Produto field, not itens');
      assert.deepEqual(clone(app.context.getOrderItems(loaded)).map((item) => [item.produto, item.quantidade]), scenario.items);
      assert.equal(app.context.getOrderNumericValue(loaded), scenario.total);
      assert.deepEqual(backend.rows[0], HEADERS);
      assert.deepEqual(backend.rows[1], LEGACY_ROW);
      assert.equal(backend.appended(), 1);
      assert.equal(backend.files(), 1);
      assert.equal(app.networkAttempts(), 0);
    });
  }
});

test('Scenario D: personalized Jerseys remain distinct and survive a 13-column backend round-trip', () => {
  const app = createFrontend();
  app.add('Jersey', { size: 'M', name: 'ALESSANDRO', number: '07' });
  app.add('Jersey', { size: 'G', name: "JOÃO D'ÁVILA", number: '00' });
  const order = app.checkout();
  assert.equal(order.valorTotal, 200);
  assert.equal(order.itens.length, 2);
  assert.match(order.produto, /Jersey \(M\) x1 \[Nome: ALESSANDRO; Número: 07\]/);
  assert.match(order.produto, /Jersey \(G\) x1 \[Nome: JOÃO D'ÁVILA; Número: 00\]/);
  const backend = createMemoryBackend();
  backend.add(order);
  const loaded = backend.get().orders.find((item) => item.id === order.id);
  const items = clone(app.context.getOrderItems(loaded));
  assert.deepEqual(items.map((item) => [item.tamanho, item.nomeCamisa, item.numeroCamisa]), [
    ['M', 'ALESSANDRO', '07'], ['G', "JOÃO D'ÁVILA", '00']
  ]);
  assert.equal(app.context.getOrderRowPrice(loaded, 'Jersey'), 'R$ 200,00');
  assert.equal(app.context.getOrderSizeForTab(loaded, 'Jersey'), 'M, G');
  assert.match(app.context.getOrderProductForTab(loaded, 'Jersey'), /Número: 07/);
  assert.match(app.context.getOrderProductForTab(loaded, 'Jersey'), /Número: 00/);
  assert.deepEqual(backend.rows[1], LEGACY_ROW);
  assert.equal(backend.rows[2].length, 13);
  assert.equal(app.networkAttempts(), 0);
});

test('Single personalized Jersey is included in Produto even without adding to the cart first', () => {
  const app = createFrontend();
  app.configure('Jersey', { size: 'P', quantity: 2, name: 'ANA-MARIA', number: '07' });
  const order = app.checkout();
  assert.equal(order.valorTotal, 200);
  assert.equal(order.produto, 'Jersey (P) x2 [Nome: ANA-MARIA; Número: 07]');
  const backend = createMemoryBackend();
  backend.add(order);
  const loaded = backend.get().orders.find((item) => item.id === order.id);
  const [item] = clone(app.context.getOrderItems(loaded));
  assert.equal(item.nomeCamisa, 'ANA-MARIA');
  assert.equal(item.numeroCamisa, '07');
  assert.equal(item.quantidade, 2);
  assert.equal(app.context.getOrderNumericValue(loaded), 200);
});

test('Cart merges only equal product, size, name and number', () => {
  const app = createFrontend();
  app.add('Jersey', { size: 'M', name: 'ANA', number: '07' });
  app.add('Jersey', { size: 'M', name: 'ANA', number: '07', quantity: 2 });
  app.add('Jersey', { size: 'M', name: 'BIA', number: '07' });
  app.add('Jersey', { size: 'M', name: 'ANA', number: '00' });
  app.add('Jersey', { size: 'G', name: 'ANA', number: '07' });
  const cart = app.read('orderCart');
  assert.equal(cart.length, 4);
  assert.equal(cart[0].quantidade, 3);
  assert.equal(cart[0].subtotal, 300);
  assert.equal(cart.reduce((sum, item) => sum + item.subtotal, 0), 600);
  assert.equal(app.element('f_jersey_numero').value, '07');
});

test('Jersey customization is optional as a pair and rejects unsafe or invalid input', async (t) => {
  for (const [name, number] of [
    ['ANA', ''], ['', '07'], ['A'.repeat(31), '10'], ['ANA; X', '10'],
    ['<script>', '10'], ['ANA', '100'], ['ANA', '-1'], ['ANA', '7.5'], ['ANA', 'A7']
  ]) {
    await t.test(`reject ${JSON.stringify([name, number])}`, () => {
      const app = createFrontend();
      app.configure('Jersey', { name, number });
      app.context.addItemToOrder();
      assert.equal(app.read('orderCart').length, 0);
      assert.equal(app.checkout(), null, 'Invalid personalization cannot proceed directly to review');
      assert.equal(app.networkAttempts(), 0);
    });
  }
  for (const [name, number] of [['', ''], ['A'.repeat(30), '0'], ["JOÃO D'ÁVILA", '07'], ['ANA-MARIA', '00']]) {
    await t.test(`accept ${JSON.stringify([name, number])}`, () => {
      const app = createFrontend();
      app.add('Jersey', { name, number });
      assert.equal(app.read('orderCart').length, 1);
      assert.equal(app.read('orderCart')[0].unitPrice, 100);
      assert.equal(app.read('orderCart')[0].numeroCamisa, number);
    });
  }
});

test('Product navigation preserves the Jersey name, leading zero, and each clothing size', () => {
  const app = createFrontend();
  app.configure('Jersey', { size: 'GG', name: 'ANA-MARIA', number: '07' });
  app.context.selectProduct('Caneca individual', app.products.get('Caneca individual'));
  assert.equal(app.element('f_tamanho').value, '-');
  app.context.selectProduct('Oversize', app.products.get('Oversize'));
  app.context.selectSize('P', app.sizes.get('P'));
  app.context.selectProduct('Jersey', app.products.get('Jersey'));
  const item = clone(app.context.getCurrentFormItem());
  assert.equal(item.tamanho, 'GG');
  assert.equal(item.nomeCamisa, 'ANA-MARIA');
  assert.equal(item.numeroCamisa, '07');
  app.context.selectProduct('Oversize', app.products.get('Oversize'));
  assert.equal(app.element('f_tamanho').value, 'P');
});

test('Combo and individual products never leak into one another’s dashboard filters or subtotals', () => {
  const app = createFrontend();
  const combined = {
    produto: 'Caneca + Tirante (-) x2 + Caneca individual (-) x3 + Tirante individual (-) x4 + Eco Bag (-) x1',
    tamanho: '-', quantidade: 10, valorTotal: 'R$ 290,00'
  };
  const parsed = clone(app.context.getOrderItems(combined));
  assert.deepEqual(parsed.map((item) => [item.produto, item.quantidade]), [
    ['Caneca', 2], ['Caneca individual', 3], ['Tirante individual', 4], ['Eco Bag', 1]
  ]);
  for (const [key, price] of [['Caneca', 90], ['Caneca individual', 105], ['Tirante individual', 60], ['Eco Bag', 35]]) {
    assert.ok(app.context.orderHasProduct(combined, key));
    assert.equal(app.context.getOrderRowPrice(combined, key), `R$ ${price},00`);
  }
  for (const product of ['Caneca', 'Caneca individual', 'Tirante individual']) {
    const order = { produto: product, tamanho: '-', quantidade: 1 };
    for (const key of ['Caneca', 'Caneca individual', 'Tirante individual']) {
      assert.equal(app.context.orderHasProduct(order, key), product === key);
    }
  }
});

test('Legacy descriptions and historical totals remain compatible without mutating source orders', () => {
  const app = createFrontend();
  const orders = [
    { produto: 'Caneca', tamanho: '-', quantidade: 2, valorTotal: 'R$ 80,00' },
    { produto: 'Eco Bag', tamanho: '-', quantidade: 1, valorTotal: 30 },
    { produto: 'Jersey', tamanho: 'GG', quantidade: 2, valorTotal: 'R$ 180,00' },
    { produto: 'Corta Vento (M) x1 + Oversize (G) x2', tamanho: 'Múltiplos', quantidade: 3, valorTotal: 'R$ 275,00' },
    { produto: 'Caneca + Tirante (-) x2 + Jersey (P) x1', tamanho: 'P', quantidade: 3, valorTotal: 'R$ 175,00' },
    { produto: 'Corta Vento', tamanho: 'M', quantidade: 1, valorTotal: 'R$ 165,00' }
  ];
  const before = clone(orders);
  for (let index = 0; index < orders.length; index += 1) {
    assert.equal(app.context.getOrderNumericValue(orders[index]), [80, 30, 180, 275, 175, 165][index]);
    app.context.getOrderItems(orders[index]);
  }
  assert.equal(app.context.getOrderRowPrice(orders[0], 'Caneca'), 'R$ 80,00');
  assert.equal(app.context.getOrderRowPrice(orders[1], 'Eco Bag'), 'R$ 30,00');
  assert.equal(app.context.getOrderRowPrice(orders[2], 'Jersey'), 'R$ 180,00');
  assert.equal(app.context.getOrderRowPrice(orders[5], 'Corta Vento'), 'R$ 165,00');
  assert.equal(app.context.getOrderSizeForTab(orders[3], 'Oversize'), 'G');
  assert.deepEqual(clone(app.context.getOrderItems(orders[4])).map((item) => [item.produto, item.quantidade]), [['Caneca', 2], ['Jersey', 1]]);
  assert.deepEqual(orders, before);
});

test('Serialized itens use their stored unit prices and preserve personalization', () => {
  const app = createFrontend();
  const order = {
    produto: 'Jersey (M) x2 [Nome: ANA; Número: 07]', quantidade: 2,
    itens: JSON.stringify([{ produto: 'Jersey', tamanho: 'M', quantidade: 2, unitPrice: 90, subtotal: 180, nomeCamisa: 'ANA', numeroCamisa: '07' }])
  };
  assert.equal(app.context.getOrderNumericValue(order), 180);
  assert.equal(app.context.getOrderRowPrice(order, 'Jersey'), 'R$ 180,00');
  const [item] = clone(app.context.getOrderItems(order));
  assert.equal(item.numeroCamisa, '07');
  assert.equal(item.unitPrice, 90);
});

test('Excel export keeps distinct product tabs and personalized Jersey descriptions', () => {
  const app = createFrontend();
  const base = { data: '17/10/2026 10:00', cpf: '', comissario: 'Comissário local', statusPagamento: 'Confirmado', statusEntrega: 'Pendente', tamanho: '-', quantidade: 1 };
  app.set('orders', [
    { ...base, nome: 'Combo', produto: 'Caneca', valorTotal: 'R$ 42,00' },
    { ...base, nome: 'Caneca individual', produto: 'Caneca individual', valorTotal: 'R$ 35,00' },
    { ...base, nome: 'Tirante individual', produto: 'Tirante individual', valorTotal: 'R$ 15,00' },
    { ...base, nome: 'Jersey', produto: 'Jersey (G) x1 [Nome: ANA; Número: 07]', tamanho: 'G', valorTotal: 'R$ 100,00' }
  ]);
  app.context.exportToExcel();
  const { book, filename } = app.exported();
  assert.match(filename, /\.xlsx$/);
  const combo = book.sheets.Caneca || book.sheets['Caneca + Tirante'];
  assert.equal(combo.length, 2);
  assert.equal(combo[1][1], 'Combo');
  assert.equal(combo[1][6], 'R$ 42,00');
  for (const key of ['Caneca individual', 'Tirante individual']) {
    assert.ok(book.sheets[key], `Missing product sheet: ${key}`);
    assert.equal(book.sheets[key].length, 2);
    assert.equal(book.sheets[key][1][1], key);
  }
  assert.match(book.sheets.Jersey[1][4], /Nome: ANA; Número: 07/);
  assert.equal(book.sheets['Todas as Respostas'].length, 5);
  assert.equal(book.sheets['Ranking Comissarios'].at(-1)[2], 'R$ 192,00');
  assert.equal(app.networkAttempts(), 0);
});

test('Product names printed on a Jersey never become extra order items', () => {
  const app = createFrontend();
  const order = {
    produto: 'Jersey (M) x1 [Nome: CANECA; Número: 07] + Jersey (M) x1 [Nome: JERSEY; Número: 10]',
    tamanho: 'M', quantidade: 2
  };
  const items = clone(app.context.getOrderItems(order));
  assert.equal(items.length, 2);
  assert.equal(app.context.orderHasProduct(order, 'Caneca'), false);
  assert.equal(app.context.getOrderNumericValue(order), 200);
  assert.equal(app.context.getOrderSizeForTab(order, 'Jersey'), 'M');
  assert.deepEqual(items.map(item => item.numeroCamisa), ['07', '10']);
});

test('Checkout uses only added items and a review snapshot does not mutate with the draft', () => {
  const app = createFrontend();
  app.add('Jersey', { size: 'M', name: 'ANA', number: '07' });
  app.configure('Jersey', { size: 'G', name: 'UNADDED', number: '' });
  const order = app.checkout();
  assert.equal(order.valorTotal, 100);
  assert.match(order.produto, /Nome: ANA; Número: 07/);
  assert.doesNotMatch(order.produto, /UNADDED/);
  app.context.backToOrderForm();
  app.configure('Jersey', { size: 'M', quantity: 2, name: 'ANA', number: '07' });
  app.context.addItemToOrder();
  assert.equal(app.read('pendingOrderData.itens[0].quantidade'), 1);
  assert.equal(app.read('orderCart[0].quantidade'), 3);
});

test('Final confirmation hands the personalized order to the existing sender and clears the draft', () => {
  const app = createFrontend();
  app.add('Jersey', { size: 'GG', name: 'ANA', number: '07' });
  const order = app.checkout();
  const sent = [];
  app.context.sendToGoogleSheets = payload => sent.push(clone(payload));
  app.context.finalizeConfirmedOrder();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'addOrder');
  assert.equal(sent[0].order.produto, order.produto);
  assert.equal(sent[0].order.valorTotal, 100);
  assert.equal(app.read('orders[0].produto'), order.produto);
  assert.match(app.element('successProductsSummary').innerText, /Nome: ANA; Número: 07/);
  assert.equal(app.element('confirmSuccessBox').style.display, 'block');
  assert.deepEqual(app.read('orderCart'), []);
  assert.equal(app.read('pendingOrderData'), null);
  assert.equal(app.element('f_jersey_nome').value, '');
  assert.equal(app.element('f_jersey_numero').value, '');
  assert.equal(app.element('jerseyCustomization').hidden, true);
  assert.equal(app.element('f_jersey_nome').disabled, true);
  assert.equal(app.networkAttempts(), 0);
});
