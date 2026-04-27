# Gerenciamento de Processos

Aplicação web para cadastro e acompanhamento de processos e etapas, com tabela, gráfico e **dados compartilhados no servidor** (vários usuários veem e editam a mesma base).

## Funcionalidades

- Criação e edição de processos.
- Cadastro, edição e exclusão de etapas.
- Status por etapa.
- Gráfico de evolução do processo.
- Exportação e importação de dados em JSON (gravação no servidor após importar).
- **Persistência no servidor** via API na Vercel usando **Vercel Blob** (ficheiro JSON) — não usa `localStorage` nem outra integração.
- **Upload de arquivos** por processo (armazenamento Vercel Blob); links públicos para download.

## Estrutura do projeto

- `index.html`: interface.
- `styles.css`: estilos.
- `app.js`: lógica e chamadas a `/api/state` e `/api/upload`.
- `api/state.js`: leitura/gravação do estado JSON no Vercel Blob.
- `api/upload.js`: envio de arquivos para Vercel Blob.
- `package.json`: dependência `@vercel/blob`.

## Variáveis de ambiente (Vercel)

No painel do projeto: **Settings → Environment Variables**:

| Variável | Onde obter |
|----------|------------|
| `BLOB_READ_WRITE_TOKEN` | Obrigatório: criar um store em [Vercel Blob](https://vercel.com/docs/storage/vercel-blob) e ligar ao projeto — a variável costuma ser criada automaticamente. O estado da app grava-se num JSON no Blob e os uploads de anexos usam o mesmo token. |

Se `BLOB_READ_WRITE_TOKEN` não estiver definido, `/api/state` responde 503.

## Deploy na Vercel

1. Envie o código para um repositório Git (GitHub, etc.).
2. **Add New Project** na Vercel e importe o repositório.
3. **Framework Preset**: Other (ou detecta `package.json`).
4. Adicione a variável de ambiente `BLOB_READ_WRITE_TOKEN`.
5. Faça o deploy.

Após o primeiro acesso sem estado salvo, a aplicação cria o processo de exemplo e grava no Blob.

## Execução local

Para testar as APIs com as mesmas variáveis do projeto:

```bash
npm install
npx vercel dev
```

Abra o endereço indicado no terminal (as rotas `/api/*` não funcionam com `python -m http.server` apenas).

## Observações

- **Segurança**: qualquer visitante pode alterar dados e enviar arquivos. Para uso interno restrito, coloque o site atrás de autenticação (por exemplo Vercel Authentication, SSO da empresa ou VPN).
- O estado é um único documento JSON no Blob; gravações muito simultâneas usam “última gravação vence”.
- A interface consulta o servidor a cada ~12 s para refletir alterações de outros usuários (e ao voltar para a aba).
