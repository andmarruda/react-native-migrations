# O Que Ainda Falta para Passar de 95% de Coverage em Testes

O ultimo coverage medido ficou em torno de:

- todos os arquivos: `89.36%` lines
- todos os arquivos: `88.76%` branches
- todos os arquivos: `93.24%` functions

Este documento explica o que mais importa agora para passar de `95%+` com confianca.

## Principal Gargalo: Coverage da CLI

Hoje a maior queda de coverage vem da CLI.

Area observada:

- [bin/rn-sqlite-migrations.cjs](/home/anderson/econorg/sqlite-migration/bin/rn-sqlite-migrations.cjs)

Por que:

- varios testes da CLI falham em ambientes restritos porque dependem de `spawnSync node`
- com isso, ramos importantes de sucesso e erro nao sao executados de forma confiavel

O que fazer:

- refatorar a CLI em funcoes puras e testaveis
- exportar os handlers dos comandos a partir de um modulo compartilhado
- deixar o arquivo `bin/` como um wrapper bem fino
- testar o comportamento dos comandos sem abrir um child process

So essa mudanca ja deve empurrar o coverage para cima de forma relevante.

## Lacunas no Catalog

O arquivo do catalogo esta perto, mas ainda nao fechou tudo.

Ainda vale testar:

- nome de migration vazio
- arquivo `up` ausente
- casos de ordenacao com mais de uma entrada

## Lacunas no Runner

O runner ja esta muito forte, mas ainda deve ter alguns ramos abertos.

Pelo relatorio atual, as areas mais provaveis sao:

- rollback real quando existe registro aplicado e o catalogo nao encontra a migration
- alguns caminhos de retorno vazio e geracao de plano
- ramos de logger nao exercitados em todas as fases

## SQL e Types

Esses arquivos ja estao em ou muito perto de cobertura total, entao nao sao o gargalo principal.

## Estrategia Mais Eficiente para Chegar em 95%+

O caminho mais eficiente agora e:

1. refatorar a CLI para funcoes importaveis
2. testar parsing e execucao dos comandos diretamente
3. adicionar testes negativos explicitos no catalogo
4. rerodar coverage e fechar os poucos ramos restantes do runner

## Nota Importante

Um pacote pode ter coverage alto e ainda assim nao ser seguro no mundo real.

Entao a meta deveria ser:

- `95%+` de coverage medido
- testes passando
- branch coverage forte em fluxos de falha e recuperacao

## Apoio

Se este pacote ajuda o seu trabalho e voce quiser apoiar o desenvolvimento:

- Buy Me a Coffee: `buymeacoffee.com/andmarruda`
