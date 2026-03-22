# react-native-sqlite-migrations

Lib de migrations para React Native com SQLite, inspirada no fluxo do Laravel:

- migrations ordenadas por nome/timestamp
- tabela de controle com `batch`
- `up` e `down`
- hook semantico para migracao de dados antes de SQL destrutivo
- SQLs mantidos fora da lib, em uma pasta apontada pelo app

## Ideia

O app continua dono do banco e dos arquivos SQL, mas deixa a orquestracao de migrations com a lib.

Isso ajuda quando a estrutura muda e voce precisa:

1. mover dados para uma nova tabela ou coluna
2. validar / normalizar dados existentes
3. so depois remover colunas, dropar tabelas ou recriar estruturas

## Estrutura sugerida no app

```text
src/
  database/
    migrations/
      202603210001_create_users.up.sql
      202603210001_create_users.down.sql
      202603210002_split_full_name.up.sql
      202603210002_split_full_name.down.sql
```

## API

```ts
import { defineMigrations, MigrationRunner } from "react-native-sqlite-migrations";

const catalog = defineMigrations({
  directory: "src/database/migrations",
  migrations: [
    {
      name: "202603210001_create_users",
      sql: {
        up: "202603210001_create_users.up.sql",
        down: "202603210001_create_users.down.sql",
      },
    },
    {
      name: "202603210002_split_full_name",
      sql: {
        up: "202603210002_split_full_name.up.sql",
        down: "202603210002_split_full_name.down.sql",
      },
      beforeDestructive: async ({ db }) => {
        await db.execute({
          sql: "ALTER TABLE users ADD COLUMN first_name TEXT",
        });

        await db.execute({
          sql: "ALTER TABLE users ADD COLUMN last_name TEXT",
        });

        const rows = await db.query<{ id: number; full_name: string | null }>({
          sql: "SELECT id, full_name FROM users",
        });

        for (const row of rows) {
          const [firstName, ...rest] = (row.full_name ?? "").trim().split(/\s+/);
          await db.execute({
            sql: "UPDATE users SET first_name = ?, last_name = ? WHERE id = ?",
            params: [firstName ?? null, rest.join(" ") || null, row.id],
          });
        }
      },
    },
  ],
});

const runner = new MigrationRunner({
  db: sqliteExecutor,
  catalog,
  readSqlFile: async ({ directory, path }) => {
    return loadSqlFromBundle(`${directory}/${path}`);
  },
});

await runner.migrate();
```

## Contrato do executor

A lib nao acopla em `expo-sqlite`, `react-native-quick-sqlite` ou outro driver especifico.
O app fornece um adaptador com este formato:

```ts
type SqliteExecutor = {
  execute(statement: { sql: string; params?: Array<string | number | null> }): Promise<void>;
  query<T>(statement: { sql: string; params?: Array<string | number | null> }): Promise<T[]>;
  withTransaction<T>(callback: () => Promise<T>): Promise<T>;
};
```

## Fluxo de migracao

Ao chamar `migrate()` a lib:

1. cria a tabela de controle se nao existir
2. descobre migrations pendentes
3. abre uma transacao por migration
4. executa `beforeDestructive`
5. executa `beforeUp`
6. carrega o arquivo `.up.sql`
7. roda os statements SQL em sequencia
8. registra a migration com `batch`

Ao chamar `rollbackLastBatch()` a lib:

1. pega o ultimo `batch`
2. executa as migrations em ordem reversa
3. roda `beforeDown`, `down.sql` e `afterDown`
4. remove o registro da tabela de controle

## Quando usar `beforeDestructive`

Use `beforeDestructive` quando voce precisa migrar dados antes de uma mudanca destrutiva. Exemplo:

- copiar dados de `full_name` para `first_name` e `last_name`
- mover registros de uma tabela antiga para uma nova
- consolidar enums, status ou formatos antigos
- criar tabela temporaria antes de recriar uma estrutura

Depois disso, o `.up.sql` pode focar na mudanca estrutural final.

Se quiser, `beforeUp` continua disponivel como hook generico antes do SQL principal.

## Exemplo de loader

Em React Native, acesso a arquivos nem sempre e dinamico em runtime. Por isso a lib recebe `readSqlFile` em vez de assumir `fs`.

Isso deixa voce livre para:

- usar `require`
- usar assets empacotados
- usar um manifest gerado no build
- buscar SQL de um bundle local

Exemplo conceitual:

```ts
const sqlFiles = {
  "src/database/migrations/202603210001_create_users.up.sql": require("./src/database/migrations/202603210001_create_users.up.sql"),
};

async function loadSqlFromBundle(path: string) {
  return sqlFiles[path];
}
```

## Proximos passos

Boas evolucoes para essa base:

- criar helpers prontos para `expo-sqlite`
- adicionar checksum dos arquivos SQL
- gerar manifest automatico da pasta de migrations
- expor comando CLI para validar ordem e nomes

## Internal Docs

Additional English documentation lives in:

- `docs/architecture.md`
- `docs/improvements.md`
- `docs/implementation-tasks.md`
- `docs/quickstart.md`

## CLI

The package now includes a local maintenance CLI:

```bash
rn-sqlite-migrations help
rn-sqlite-migrations create add_users --dir src/database/migrations
rn-sqlite-migrations validate --dir src/database/migrations
rn-sqlite-migrations manifest --dir src/database/migrations --out src/database/migrations/manifest.generated.json
```

## Examples

Consumer examples live in:

- `examples/basic-usage.ts`
- `examples/logger.ts`

## Local Testing

Run the isolated package checks with:

```bash
npm test
```

This script:

1. builds the package into `dist/`
2. imports the built output
3. runs local tests against the package in isolation
