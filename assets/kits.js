// Catálogo promocional local. Valores de composição em centavos, sem alterações no backend.
(() => {
  const sizes = Object.freeze(['PP', 'P', 'M', 'G', 'GG', 'XGG']);
  const definitions = Object.freeze({
    campus: { nome: 'Kit Campus', roupas: ['Oversize'], escolha: true,
      componentes: [['Oversize', 6500]], descricao: 'Oversize + Ecobag ou Caneca' },
    'look-tube': { nome: 'Kit Look Tube', roupas: ['Tube Top'], escolha: true, ambos: true, tirante: true,
      componentes: [['Tube Top', 5000]], descricao: 'Tube Top + Ecobag ou Caneca + Tirante' },
    torcida: { nome: 'Kit Torcida', roupas: ['Jersey'],
      componentes: [['Jersey', 10000], ['Caneca individual', 3000], ['Tirante individual', 1000]],
      descricao: 'Jersey + Caneca + Tirante' },
    'campus-completo': { nome: 'Kit Campus Completo', roupas: ['Oversize', 'Corta Vento'],
      componentes: [['Oversize', 6500], ['Corta Vento', 18000], ['Caneca individual', 2500], ['Tirante individual', 1000]],
      descricao: 'Oversize + Corta Vento + Caneca + Tirante' },
    'frio-no-campus': { nome: 'Kit Frio no Campus', roupas: ['Corta Vento'], escolha: true, ambos: true, tirante: true,
      componentes: [['Corta Vento', 18000]], descricao: 'Corta Vento + Ecobag ou Caneca + Tirante' },
    'tudo-pesadelo': { nome: 'Kit Tudo Pesadelo', roupas: ['Tube Top', 'Jersey', 'Oversize', 'Corta Vento'],
      componentes: [['Tube Top', 5000], ['Eco Bag', 3000], ['Jersey', 9500], ['Caneca individual', 3000],
        ['Tirante individual', 1000], ['Oversize', 6000], ['Corta Vento', 18000]],
      descricao: 'Tube Top + Ecobag + Jersey + Caneca + Tirante + Oversize + Corta Vento' }
  });

  function jerseyError(name = '', number = '') {
    if (!name && !number) return null;
    if (!name || !number) return { field: name ? 'numero' : 'nome', message: 'Para personalizar a Jersey, preencha o nome e o número da camisa.' };
    if (name.length > 30 || !/^[\p{L}\p{M} '\u2019-]+$/u.test(name) || !/\p{L}/u.test(name)) {
      return { field: 'nome', message: 'Use até 30 letras no nome, com espaços, apóstrofos ou hífens.' };
    }
    if (!/^\d{1,2}$/.test(number)) return { field: 'numero', message: 'Informe um número com um ou dois dígitos, como 7, 07 ou 10.' };
    return null;
  }

  function createItem(id, options, prices) {
    const definition = definitions[id];
    if (!definition) throw new Error('Selecione um kit válido.');
    const quantity = Number(options.quantidade ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw new Error('Informe de 1 a 50 kits.');
    const composition = definition.componentes.map(item => [...item]);
    let accessory = '';
    if (definition.escolha) {
      accessory = options.acessorio || 'Eco Bag';
      if (!['Eco Bag', 'Caneca individual', ...(definition.ambos ? ['ambos'] : [])].includes(accessory)) {
        throw new Error('Escolha um acessório disponível para este kit.');
      }
      const accessories = accessory === 'ambos' ? ['Eco Bag', 'Caneca individual'] : [accessory];
      accessories.forEach(product => composition.push([product, 3000]));
      if (definition.tirante) composition.push(['Tirante individual', 1000]);
    }
    const name = String(options.nomeCamisa || '').normalize('NFC').trim().replace(/\s+/g, ' ');
    const number = String(options.numeroCamisa || '').trim();
    if (definition.roupas.includes('Jersey')) {
      const error = jerseyError(name, number);
      if (error) throw new Error(error.message);
    }
    const components = composition.map(([product, cents]) => {
      const size = definition.roupas.includes(product) ? (options.tamanhos?.[product] || 'M') : '-';
      if (definition.roupas.includes(product) && !sizes.includes(size)) throw new Error('Selecione um tamanho disponível para cada roupa.');
      if (!Number.isInteger(Math.round(prices[product] * 100)) || !(prices[product] > 0)) throw new Error('Preço de referência indisponível.');
      return { produto: product, tamanho: size, quantidade: 1, unitPrice: cents / 100, subtotal: cents / 100,
        ...(product === 'Jersey' ? { nomeCamisa: name, numeroCamisa: number } : {}) };
    });
    const totalCents = composition.reduce((sum, [, cents]) => sum + cents, 0);
    const referenceCents = components.reduce((sum, item) => sum + Math.round(prices[item.produto] * 100), 0);
    return { tipo: 'kit', kitId: id, produto: definition.nome, acessorio: accessory,
      tamanho: [...new Set(components.map(item => item.tamanho).filter(size => size !== '-'))].join(', ') || '-',
      quantidade: quantity, unitPrice: totalCents / 100, subtotal: totalCents * quantity / 100,
      valorAvulso: referenceCents / 100, economia: (referenceCents - totalCents) / 100, componentes: components };
  }

  function expandItems(items) {
    return items.flatMap(item => item.tipo === 'kit' && Array.isArray(item.componentes)
      ? item.componentes.map(component => {
        const quantity = component.quantidade * item.quantidade;
        return { ...component, quantidade: quantity, subtotal: Math.round(component.unitPrice * 100) * quantity / 100,
          kitId: item.kitId, kitNome: item.produto, quantidadeKits: item.quantidade };
      }) : [{ ...item }]);
  }

  function describeItem(item, describeProduct, currency) {
    const contents = item.componentes.map(component =>
      `${describeProduct(component)} [Unitário: ${currency(component.unitPrice)}]`).join(' | ');
    return `${item.produto} {${contents}} x${item.quantidade}`;
  }

  // O texto guarda composição, tamanhos, personalização e preço de cada componente.
  // A consulta existente pode retornar só Produto e Valor Total, sem array de itens.
  function extractDescriptions(text, parseProducts) {
    const names = Object.values(definitions).map(definition => definition.nome).sort((a, b) => b.length - a.length);
    const pattern = new RegExp('(?:^|\\s+\\+\\s+)(' + names.join('|') + ') \\{([^{}]+)\\} x(\\d+)(?=\\s+\\+\\s+|$)', 'g');
    const items = [];
    const remainder = text.replace(pattern, (whole, name, body, count) => {
      const components = [];
      for (const part of body.split(' | ')) {
        const match = part.match(/^(.*) \[Unitário: R\$ ([\d.]+,\d{2})\]$/);
        if (!match) return whole;
        const parsed = parseProducts(match[1]);
        if (parsed.length !== 1) return whole;
        const unitPrice = Number(match[2].replace(/\./g, '').replace(',', '.'));
        if (!(unitPrice > 0)) return whole;
        components.push({ ...parsed[0], unitPrice, subtotal: Math.round(unitPrice * 100) * parsed[0].quantidade / 100 });
      }
      const id = Object.keys(definitions).find(key => definitions[key].nome === name);
      const quantity = Number(count);
      if (!Number.isInteger(quantity) || quantity < 1) return whole;
      items.push(...expandItems([{ tipo: 'kit', kitId: id, produto: name, quantidade: quantity, componentes: components }]));
      return ' ';
    });
    return { items, remainder: remainder.replace(/^\s*\+\s*|\s*\+\s*$/g, '').trim() };
  }

  globalThis.PesadeloKits = Object.freeze({ definitions, sizes, createItem, expandItems, describeItem, extractDescriptions, jerseyError });
})();
