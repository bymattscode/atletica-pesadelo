// Carregado apenas pelo servidor de prévia, antes do JavaScript da aplicação.
(() => {
  const key = 'PESADELO_PREVIEW_DATABASE_V1';
  const endpoint = '/__preview__/api';
  const emptyDatabase = () => ({ orders: [], comissarios: ['Comissário de teste A', 'Comissário de teste B'] });
  let database;
  try {
    database = JSON.parse(localStorage.getItem(key)) || emptyDatabase();
  } catch (_) {
    database = emptyDatabase();
  }
  const persist = () => localStorage.setItem(key, JSON.stringify(database));
  const response = body => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });

  // O endpoint da prévia é fixo e usa um namespace separado do armazenamento real.
  localStorage.setItem('PESADELO_PREVIEW_SHEETS_URL', endpoint);
  window.__previewRequests = [];
  window.fetch = async (input, options = {}) => {
    const requested = new URL(typeof input === 'string' ? input : input.url, location.origin);
    if (requested.origin !== location.origin || requested.pathname !== endpoint) {
      throw new Error('A prévia local bloqueou uma conexão fora da API simulada.');
    }
    const method = options.method || 'GET';
    window.__previewRequests.push({ url: requested.href, method, body: options.body || null });
    if (method === 'GET') return response({ status: 'success', ...database });
    if (method !== 'POST') throw new Error('Método indisponível na prévia.');
    const payload = JSON.parse(options.body || '{}');
    if (payload.action === 'addOrder') {
      const order = { ...payload.order, valorTotal: payload.order.valorFormatado || payload.order.valorTotal };
      // Assim como o backend atual, a consulta retorna a descrição de Produto.
      delete order.itens;
      database.orders.push(order);
    } else if (payload.action === 'updateOrder') {
      const order = database.orders.find(item => item.id === payload.id);
      if (order && payload.statusPagamento) order.statusPagamento = payload.statusPagamento;
      if (order && payload.statusEntrega) order.statusEntrega = payload.statusEntrega;
    } else if (payload.action === 'deleteOrder') {
      database.orders = database.orders.filter(order => order.id !== payload.id);
    } else if (payload.action === 'addComissario') {
      if (!database.comissarios.some(name => name.toLowerCase() === payload.nome.toLowerCase())) {
        database.comissarios.push(payload.nome);
      }
    } else if (payload.action === 'deleteComissario') {
      database.comissarios = database.comissarios.filter(name => name !== payload.nome);
    } else {
      return response({ status: 'error', message: 'Ação indisponível na prévia.' });
    }
    persist();
    return response({ status: 'success' });
  };
})();
