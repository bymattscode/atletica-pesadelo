# Testes locais e preservação dos dados

Execute os comandos nesta pasta do projeto (`atletica-pesadelo`):

```sh
node tests/catalog-checkout.test.cjs
node tests/browser-checkout.cjs
node tests/local-preview.test.cjs
node tests/browser-checkout.cjs --preview
```

Os testes requerem Node.js 24. O teste de navegador usa Google Chrome em
`/usr/bin/google-chrome`; outro executável pode ser informado em `CHROME_PATH`.
Não há dependências adicionais para instalar.

## Isolamento

- A suíte de regras executa o JavaScript real da página em uma VM com DOM,
  armazenamento e exportação Excel simulados. A função `fetch` é bloqueada.
- O Apps Script original é executado somente em outra VM, com Sheets e Drive
  representados por objetos em memória. Nenhum serviço Google é acessado.
- A confirmação final é testada com o remetente substituído por uma função local.
- O teste de navegador usa um perfil temporário e um servidor HTTP apenas em
  `127.0.0.1`. Antes da página carregar, substitui `fetch` por um mock e bloqueia
  requisições externas pelo protocolo do Chrome, além de usar proxy externo
  indisponível e resolução de nomes restrita.
- As capturas de tela são gravadas em um diretório temporário informado no
  resultado do teste. O perfil do usuário não é usado.

Não abra a página normal para testar com dados fictícios: a inicialização normal
sincroniza com a URL de produção. Até o GET do backend executa `setupDatabase`.
Utilize os testes isolados acima ou a [prévia manual local](../README.md).
O argumento `--preview` valida também o servidor de prévia manual e sua API
simulada, mantendo o bloqueio externo do navegador de testes.

## Contrato preservado

`Caneca` continua sendo o identificador histórico do combo de R$ 45,00.
Os produtos avulsos se chamam `Caneca individual` (R$ 35,00) e
`Tirante individual` (R$ 15,00). `Eco Bag` mantém a identificação histórica e é
exibido como Ecobag (R$ 35,00). A Jersey continua custando R$ 100,00.

Nome e número são opcionais em conjunto. Quando preenchidos, a descrição
existente de Produto inclui os dados, por exemplo:

```text
Jersey (M) x1 [Nome: ALESSANDRO; Número: 07]
```

O backend já grava e devolve esse texto integralmente; os testes verificam essa
ida e volta usando o código original com as mesmas 13 colunas. O array `itens`
continua disponível localmente, e a interface recupera os itens da descrição
quando a consulta retorna sem esse array. Nenhuma coluna ou registro existente
precisa ser alterado.

A suíte cobre os totais 50/45/85, Jerseys com personalizações distintas, zeros à
esquerda, validação, preservação dos tamanhos na navegação, confirmação, filtros,
exportação e compatibilidade com pedidos antigos. O navegador verifica formulário
e revisão em 360, 390 e 1440 pixels.

O projeto é HTML/CSS/JavaScript estático: não possui configuração de lint,
TypeScript ou etapa de build. A validação complementar usa `node --check`,
compilação do script inline com `vm.Script` e `git diff --check`.

Não há deploy automático, migrações, seeds ou alterações no Apps Script nestes
testes. A publicação do frontend permanece uma etapa separada.
