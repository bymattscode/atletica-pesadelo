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
  vm.runInContext(readFileSync(path.join(projectDir, 'assets/kits.js'), 'utf8'), context, { filename: 'assets/kits.js', timeout: 1000 });
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

function addKit(app, id, options = {}) {
  app.context.configureKit(id);
  if (options.acessorio) app.element('kitAccessorySelect').value = options.acessorio;
  for (const [product, size] of Object.entries(options.tamanhos || {})) {
    app.element(app.context.kitSizeId(product)).value = size;
  }
  app.element('kitJerseyName').value = options.nomeCamisa || '';
  app.element('kitJerseyNumber').value = options.numeroCamisa || '';
  app.element('kitQuantity').value = String(options.quantidade ?? 1);
  app.context.handleKitConfigChange();
  app.context.addKitToOrder();
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

test('All kit options use their exact compositions and fixed discounts through the unchanged backend', async t => {
  const scenarios = [
    ['Campus / Ecobag', 'campus', 'Eco Bag', 95, 100, [['Oversize', 65], ['Eco Bag', 30]]],
    ['Campus / Caneca', 'campus', 'Caneca individual', 95, 100, [['Oversize', 65], ['Caneca individual', 30]]],
    ['Look Tube / Ecobag', 'look-tube', 'Eco Bag', 90, 100, [['Tube Top', 50], ['Eco Bag', 30], ['Tirante individual', 10]]],
    ['Look Tube / Caneca', 'look-tube', 'Caneca individual', 90, 100, [['Tube Top', 50], ['Caneca individual', 30], ['Tirante individual', 10]]],
    ['Look Tube / ambos', 'look-tube', 'ambos', 120, 135, [['Tube Top', 50], ['Eco Bag', 30], ['Caneca individual', 30], ['Tirante individual', 10]]],
    ['Torcida', 'torcida', '', 140, 150, [['Jersey', 100], ['Caneca individual', 30], ['Tirante individual', 10]]],
    ['Campus Completo', 'campus-completo', '', 280, 295, [['Oversize', 65], ['Corta Vento', 180], ['Caneca individual', 25], ['Tirante individual', 10]]],
    ['Frio / Ecobag', 'frio-no-campus', 'Eco Bag', 220, 230, [['Corta Vento', 180], ['Eco Bag', 30], ['Tirante individual', 10]]],
    ['Frio / Caneca', 'frio-no-campus', 'Caneca individual', 220, 230, [['Corta Vento', 180], ['Caneca individual', 30], ['Tirante individual', 10]]],
    ['Frio / ambos', 'frio-no-campus', 'ambos', 250, 265, [['Corta Vento', 180], ['Eco Bag', 30], ['Caneca individual', 30], ['Tirante individual', 10]]],
    ['Tudo Pesadelo', 'tudo-pesadelo', '', 455, 480, [['Tube Top', 50], ['Eco Bag', 30], ['Jersey', 95], ['Caneca individual', 30], ['Tirante individual', 10], ['Oversize', 60], ['Corta Vento', 180]]]
  ];
  for (const [name, id, acessorio, total, reference, composition] of scenarios) {
    await t.test(name, () => {
      const app = createFrontend();
      addKit(app, id, { acessorio, nomeCamisa: 'ANA-MARIA', numeroCamisa: '07',
        tamanhos: { 'Tube Top': 'PP', Jersey: 'P', Oversize: 'GG', 'Corta Vento': 'XGG' } });
      const [kit] = app.read('orderCart');
      assert.ok(kit, app.element('kitError').textContent);
      assert.equal(kit.tipo, 'kit');
      assert.equal(kit.unitPrice, total);
      assert.equal(kit.valorAvulso, reference);
      assert.equal(kit.economia, reference - total);
      assert.deepEqual(kit.componentes.map(item => [item.produto, item.unitPrice]), composition);
      const order = app.checkout();
      assert.equal(order.valorTotal, total);
      assert.equal(order.quantidade, composition.length);
      assert.ok(order.produto.startsWith(kit.produto + ' {'));
      assert.equal(app.element('pixTotalValueDisplay').innerText, `R$ ${total},00`);
      const backend = createMemoryBackend();
      backend.add(order);
      const loaded = backend.get().orders.find(item => item.id === order.id);
      assert.equal(loaded.produto, order.produto);
      const products = clone(app.context.getOrderItems(loaded));
      assert.deepEqual(products.map(item => [item.produto, item.unitPrice]), composition);
      assert.equal(products.reduce((sum, item) => sum + item.unitPrice * item.quantidade, 0), total);
      assert.ok(products.every(item => item.kitNome === kit.produto));
      assert.equal(app.context.orderHasProduct(loaded, 'Caneca'), false, 'No kit substitutes the legacy mug+strap combo');
      for (const product of products) {
        if (product.produto === 'Jersey') {
          assert.equal(product.nomeCamisa, 'ANA-MARIA');
          assert.equal(product.numeroCamisa, '07');
          assert.equal(product.tamanho, 'P');
        }
      }
      assert.deepEqual(backend.rows[1], LEGACY_ROW);
      assert.equal(backend.rows[2].length, 13);
      assert.equal(app.networkAttempts(), 0);
    });
  }
});

test('Kit quantities, merging, removal and mixed-cart totals preserve the included piece count', () => {
  const app = createFrontend();
  addKit(app, 'campus', { quantidade: 2 });
  assert.equal(app.read('orderCart[0].subtotal'), 190);
  assert.equal(app.checkout().quantidade, 4);
  app.context.changeKitQuantity(0, 3);
  assert.equal(app.read('orderCart[0].subtotal'), 285);
  app.context.changeKitQuantity(0, 0);
  assert.equal(app.read('orderCart[0].quantidade'), 3);
  app.context.changeKitQuantity(0, 1);
  addKit(app, 'torcida', { nomeCamisa: 'ANA', numeroCamisa: '07' });
  app.add('Caneca individual');
  const order = app.checkout();
  assert.equal(order.valorTotal, 270);
  assert.equal(order.quantidade, 6);
  const backend = createMemoryBackend();
  backend.add(order);
  const loaded = backend.get().orders.find(item => item.id === order.id);
  assert.equal(app.context.getOrderRowPrice(loaded, 'Caneca individual'), 'R$ 65,00');
  assert.equal(app.context.getOrderRowPrice(loaded, 'Oversize'), 'R$ 65,00');
  assert.equal(app.context.getOrderRowPrice(loaded, 'Jersey'), 'R$ 100,00');
  assert.match(app.context.getOrderProductForTab(loaded, 'Jersey'), /Nome: ANA; Número: 07.*Kit Torcida/);
  app.context.removeItemFromCart(0);
  assert.equal(app.read('orderCart').length, 2);
  assert.equal(app.checkout().valorTotal, 175);
});

test('Kits with different accessories, sizes or Jersey personalizations remain independent', () => {
  const app = createFrontend();
  addKit(app, 'torcida', { nomeCamisa: 'ANA', numeroCamisa: '07', tamanhos: { Jersey: 'M' } });
  addKit(app, 'torcida', { nomeCamisa: 'BIA', numeroCamisa: '00', tamanhos: { Jersey: 'G' } });
  addKit(app, 'torcida', { nomeCamisa: 'ANA', numeroCamisa: '07', tamanhos: { Jersey: 'M' } });
  addKit(app, 'campus', { acessorio: 'Eco Bag' });
  addKit(app, 'campus', { acessorio: 'Caneca individual' });
  const cart = app.read('orderCart');
  assert.equal(cart.length, 4);
  assert.equal(cart[0].quantidade, 2);
  const order = app.checkout();
  assert.equal(order.valorTotal, 610);
  const backend = createMemoryBackend();
  backend.add(order);
  const loaded = backend.get().orders.find(item => item.id === order.id);
  const jerseys = clone(app.context.getOrderItems(loaded)).filter(item => item.produto === 'Jersey');
  assert.deepEqual(jerseys.map(item => [item.nomeCamisa, item.numeroCamisa, item.tamanho, item.quantidade]), [
    ['ANA', '07', 'M', 2], ['BIA', '00', 'G', 1]
  ]);
});

test('Kit configuration preserves drafts, rejects invalid options and does not apply arbitrary discounts', () => {
  const app = createFrontend();
  app.context.configureKit('tudo-pesadelo');
  app.element('kitJerseyName').value = 'ANA';
  app.element('kitJerseyNumber').value = '07';
  app.element('kitSize-Jersey').value = 'GG';
  app.context.configureKit('campus');
  app.element('kitAccessorySelect').value = 'Caneca individual';
  app.context.configureKit('tudo-pesadelo');
  assert.equal(app.element('kitJerseyName').value, 'ANA');
  assert.equal(app.element('kitJerseyNumber').value, '07');
  assert.equal(app.element('kitSize-Jersey').value, 'GG');
  const api = app.context.PesadeloKits;
  const prices = app.read('PRECOS_PRODUTOS');
  assert.throws(() => api.createItem('campus', { acessorio: 'ambos' }, prices));
  assert.throws(() => api.createItem('torcida', { nomeCamisa: 'ANA', numeroCamisa: '' }, prices));
  assert.throws(() => api.createItem('torcida', { numeroCamisa: '100', nomeCamisa: 'ANA' }, prices));
  assert.throws(() => api.createItem('campus', { tamanhos: { Oversize: 'XXXL' } }, prices));
  assert.throws(() => api.createItem('campus', { quantidade: 1.5 }, prices));
  const fixed = api.createItem('tudo-pesadelo', { acessorio: 'ambos', unitPrice: 1, componentes: [] }, prices);
  assert.equal(fixed.componentes.length, 7);
  assert.equal(fixed.unitPrice, 455);
  app.context.resetOrderForm();
  app.add('Caneca');
  app.add('Caneca individual');
  app.add('Tirante individual');
  assert.equal(app.checkout().valorTotal, 95);
});

test('Purchased kit prices survive catalog changes, and Excel keeps kit attribution and discounts', () => {
  const app = createFrontend();
  addKit(app, 'tudo-pesadelo', { nomeCamisa: "JOÃO D'ÁVILA", numeroCamisa: '07' });
  const order = app.checkout();
  const backend = createMemoryBackend();
  backend.add(order);
  const loaded = backend.get().orders.find(item => item.id === order.id);
  const before = clone(loaded);
  app.set('PRECOS_PRODUTOS.Jersey', 200);
  app.set('PRECOS_PRODUTOS.Oversize', 120);
  assert.equal(app.context.getOrderRowPrice(loaded, 'Jersey'), 'R$ 95,00');
  assert.equal(app.context.getOrderRowPrice(loaded, 'Oversize'), 'R$ 60,00');
  assert.equal(app.context.getOrderNumericValue(loaded), 455);
  assert.equal(app.context.getOrderNumericValue({ ...loaded, valorTotal: '' }), 455);
  app.set('orders', [loaded]);
  app.context.exportToExcel();
  const sheets = app.exported().book.sheets;
  assert.match(sheets['Todas as Respostas'][1][4], /Kit Tudo Pesadelo/);
  assert.match(sheets.Jersey[1][4], /Número: 07.*Kit Tudo Pesadelo/);
  assert.equal(sheets.Jersey[1][6], 'R$ 95,00');
  assert.equal(sheets.Caneca.length, 1, 'The old combo tab must not contain kit accessories');
  assert.equal(sheets['Ranking Comissarios'].at(-1)[4], 7);
  assert.deepEqual(loaded, before);
});

test('Mixed descriptions preserve plain products and the old combo before, between and after kits', () => {
  const app = createFrontend();
  const api = app.context.PesadeloKits;
  const prices = app.read('PRECOS_PRODUTOS');
  const campus = clone(api.createItem('campus', {}, prices));
  const torcida = clone(api.createItem('torcida', { nomeCamisa: 'CANECA', numeroCamisa: '07' }, prices));
  const combo = { produto: 'Caneca', tamanho: '-', quantidade: 2, unitPrice: 45, subtotal: 90 };
  const mug = { produto: 'Caneca individual', tamanho: '-', quantidade: 1, unitPrice: 35, subtotal: 35 };
  for (const items of [[combo, campus, mug, torcida], [campus, torcida, mug, combo], [campus, mug, torcida, combo]]) {
    const text = items.map(app.context.describeOrderItem).join(' + ');
    const loaded = { produto: text, quantidade: 8 };
    const products = clone(app.context.getOrderItems(loaded));
    assert.equal(products.length, 7);
    assert.equal(app.context.getOrderNumericValue(loaded), 360);
    assert.equal(app.context.getOrderRowPrice(loaded, 'Caneca'), 'R$ 90,00');
    assert.equal(app.context.getOrderRowPrice(loaded, 'Caneca individual'), 'R$ 65,00');
    assert.equal(products.find(item => item.produto === 'Jersey').numeroCamisa, '07');
  }
});

test('Updated Campus Completo preserves independent clothing sizes and charges 560 for two kits', () => {
  const app = createFrontend();
  addKit(app, 'campus-completo', { quantidade: 2, tamanhos: { Oversize: 'PP', 'Corta Vento': 'XGG' } });
  const [kit] = app.read('orderCart');
  assert.equal(kit.kitId, 'campus-completo');
  assert.equal(kit.valorAvulso, 295);
  assert.equal(kit.economia, 15);
  assert.equal(kit.unitPrice, 280);
  assert.equal(kit.subtotal, 560);
  assert.deepEqual(kit.componentes.map(item => [item.produto, item.tamanho, item.quantidade, item.unitPrice]), [
    ['Oversize', 'PP', 1, 65], ['Corta Vento', 'XGG', 1, 180], ['Caneca individual', '-', 1, 25], ['Tirante individual', '-', 1, 10]
  ]);
  const order = app.checkout();
  assert.equal(order.valorTotal, 560);
  assert.equal(order.quantidade, 8);
  assert.doesNotMatch(order.produto, /Ecobag|Eco Bag/);
  const backend = createMemoryBackend();
  backend.add(order);
  const loaded = backend.get().orders.find(item => item.id === order.id);
  assert.equal(loaded.valorTotal, 'R$ 560,00');
  assert.equal(app.context.getOrderSizeForTab(loaded, 'Oversize'), 'PP');
  assert.equal(app.context.getOrderSizeForTab(loaded, 'Corta Vento'), 'XGG');
  assert.equal(app.context.getOrderRowPrice(loaded, 'Caneca individual'), 'R$ 50,00');
  assert.equal(app.context.orderHasProduct(loaded, 'Eco Bag'), false);
  assert.deepEqual(backend.rows[1], LEGACY_ROW);
  assert.equal(app.read('PRECOS_PRODUTOS["Caneca individual"]'), 35);
  assert.equal(app.networkAttempts(), 0);
});

test('Previously purchased Campus Completo retains the old Ecobag composition and its recorded prices', () => {
  const app = createFrontend();
  const oldOrder = {
    produto: 'Kit Campus Completo {Oversize (G) x1 [Unitário: R$ 65,00] | Ecobag (-) x1 [Unitário: R$ 30,00] | Caneca individual (-) x1 [Unitário: R$ 30,00] | Tirante individual (-) x1 [Unitário: R$ 10,00]} x1',
    tamanho: 'G', quantidade: 4, valorTotal: 'R$ 135,00'
  };
  const before = clone(oldOrder);
  assert.deepEqual(clone(app.context.getOrderItems(oldOrder)).map(item => [item.produto, item.unitPrice]), [
    ['Oversize', 65], ['Eco Bag', 30], ['Caneca individual', 30], ['Tirante individual', 10]
  ]);
  assert.equal(app.context.getOrderNumericValue(oldOrder), 135);
  assert.equal(app.context.getOrderRowPrice(oldOrder, 'Caneca individual'), 'R$ 30,00');
  assert.equal(app.context.orderHasProduct(oldOrder, 'Corta Vento'), false);
  assert.deepEqual(oldOrder, before);
});
