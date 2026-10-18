# Atlética Pesadelo

## Testar manualmente no computador

Com Node.js instalado, execute no terminal:

```sh
cd /home/lucasodpaula/Workspace/Pesadelo/app-produtos/atletica-pesadelo
node dev/server.cjs
```

Abra **http://127.0.0.1:4173** no navegador. Encerre com **Ctrl+C**.
O servidor usa somente o endereço local do computador.

Essa prévia inclui comissários fictícios e um botão **Painel de teste**.
Você pode adicionar produtos, anexar uma imagem/PDF fictício, confirmar pedidos,
alterar status, visualizar o ranking e exportar o Excel. Os dados ficam apenas no
armazenamento desse navegador e sobrevivem ao recarregamento da página.
Arquivos de comprovante grandes podem atingir o limite de armazenamento local.

A prévia substitui a integração por uma API simulada antes de carregar o app,
usa chaves locais separadas e aplica uma política do navegador que bloqueia
conexões de dados. Não acessa o Google Sheets nem o Drive. Fontes, ícones e a
biblioteca Excel continuam sendo carregados dos CDNs existentes.

Use esse comando para testes manuais: abrir `index.html` diretamente ou servir a
pasta sem o servidor de prévia carrega a configuração normal de produção.

Para usar outra porta:

```sh
PORT=4174 node dev/server.cjs
```

Os testes automatizados e seu isolamento estão documentados em
[tests/README.md](tests/README.md).

## Kits promocionais

No formulário, abra **Kits promocionais · ver opções**. Escolha **Configurar**,
selecione os acessórios/tamanhos e adicione o kit ao carrinho. Kits e produtos
avulsos podem fazer parte do mesmo pedido. Quantidades podem ser alteradas no
carrinho; configurações diferentes permanecem em linhas separadas.

| Opção | Avulsos | Kit | Economia |
| --- | ---: | ---: | ---: |
| Campus · Ecobag ou Caneca | R$ 100 | R$ 95 | R$ 5 |
| Look Tube · Ecobag ou Caneca | R$ 100 | R$ 90 | R$ 10 |
| Look Tube · Ecobag + Caneca | R$ 135 | R$ 120 | R$ 15 |
| Torcida | R$ 150 | R$ 140 | R$ 10 |
| Campus Completo · Oversize + Corta Vento + Caneca + Tirante | R$ 295 | R$ 280 | R$ 15 |
| Frio no Campus · Ecobag ou Caneca | R$ 230 | R$ 220 | R$ 10 |
| Frio no Campus · Ecobag + Caneca | R$ 265 | R$ 250 | R$ 15 |
| Tudo Pesadelo | R$ 480 | R$ 455 | R$ 25 |

Os valores e composições estão em `assets/kits.js`, calculados em centavos.
A Jersey de Torcida/Tudo Pesadelo usa a mesma validação da Jersey avulsa, com
rascunhos separados para cada kit e tamanhos independentes para cada roupa.
O combo avulso Caneca + Tirante continua custando R$ 45.

Composição, personalização e preços por componente são incluídos na descrição
existente de Produto. Isso permite consultar os kits e exportar as peças com os
preços promocionais, sem alterar a planilha ou o Apps Script. Quantidade do pedido
e ranking contam as peças incluídas; o carrinho também mostra a quantidade de kits.
Os cards usam a logo já disponível; o projeto não contém fotos dos produtos.

Se o servidor local já estava aberto antes desta atualização, encerre com Ctrl+C
e execute `node dev/server.cjs` novamente para carregar a rota de `assets/kits.js`.
