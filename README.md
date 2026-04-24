# Gerenciamento de Processos

Aplicação web para cadastro e acompanhamento de processos e etapas, com tabela, gráfico e **dados compartilhados no servidor** (vários usuários veem e editam a mesma base).

## Funcionalidades

- Criação e edição de processos.
- Cadastro, edição e exclusão de etapas.
- Status por etapa.
- Gráfico de evolução do processo.
- Exportação e importação de dados em JSON (gravação no servidor após importar).
- **Persistência em Redis (Upstash)** via API na Vercel — não usa `localStorage`.
- **Upload de arquivos** por processo (armazenamento Vercel Blob); links públicos para download.

## Estrutura do projeto

- `index.html`: interface.
- `styles.css`: estilos.
- `app.js`: lógica e chamadas a `/api/state` e `/api/upload`.
- `api/state.js`: leitura/gravação do estado JSON no Upstash Redis.
- `api/upload.js`: envio de arquivos para Vercel Blob.
- `package.json`: dependências `@upstash/redis` e `@vercel/blob`.

## Variáveis de ambiente (Vercel)

No painel do projeto: **Settings → Environment Variables**:

| Variável | Onde obter |
|----------|------------|
| `UPSTASH_REDIS_REST_URL` | Integração [Redis](https://vercel.com/marketplace?category=storage&search=redis) (Upstash) na Vercel — copiar da integração. |
| `UPSTASH_REDIS_REST_TOKEN` | Idem. |
| `BLOB_READ_WRITE_TOKEN` | Criar um store em [Vercel Blob](https://vercel.com/docs/storage/vercel-blob) e associar ao projeto (a variável costuma ser preenchida automaticamente). |

Sem Redis configurado, `/api/state` responde 503 e a interface mostra aviso (dados de exemplo só em memória até a gravação funcionar).

## Deploy na Vercel

1. Envie o código para um repositório Git (GitHub, etc.).
2. **Add New Project** na Vercel e importe o repositório.
3. **Framework Preset**: Other (ou detecta `package.json`).
4. Adicione as variáveis de ambiente acima (Redis + Blob).
5. Faça o deploy.

Após o primeiro acesso com Redis vazio, a aplicação cria o processo de exemplo e grava no Redis.

## Execução local

Para testar as APIs com as mesmas variáveis do projeto:

```bash
npm install
npx vercel dev
```

Abra o endereço indicado no terminal (as rotas `/api/*` não funcionam com `python -m http.server` apenas).

## Observações

- **Segurança**: qualquer visitante pode alterar dados e enviar arquivos. Para uso interno restrito, coloque o site atrás de autenticação (por exemplo Vercel Authentication, SSO da empresa ou VPN).
- O estado é um único documento JSON no Redis; gravações muito simultâneas usam “último gravação vence”.
- A interface consulta o servidor a cada ~12 s para refletir alterações de outros usuários (e ao voltar para a aba).
