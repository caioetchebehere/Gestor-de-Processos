const { connectLambda, getStore } = require('@netlify/blobs');

const STORE_NAME = 'gestao-novos-processos-anexos';
const EXTENSOES_PERMITIDAS = ['pdf', 'xls', 'xlsx', 'ppt', 'pptx'];

function response(statusCode, body, headers) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(headers || {})
    },
    body: JSON.stringify(body)
  };
}

function obterExtensaoArquivo(nomeArquivo) {
  if (!nomeArquivo || typeof nomeArquivo !== 'string') return '';
  const partes = nomeArquivo.toLowerCase().split('.');
  return partes.length > 1 ? partes.pop() : '';
}

function arquivoPermitido(nomeArquivo) {
  return EXTENSOES_PERMITIDAS.includes(obterExtensaoArquivo(nomeArquivo));
}

function gerarId() {
  return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
}

function normalizarSegmento(texto, fallback) {
  const valor = (texto || fallback || 'arquivo').toString();
  return valor.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || fallback || 'arquivo';
}

function montarContentDisposition(nomeArquivo) {
  const nome = typeof nomeArquivo === 'string' && nomeArquivo ? nomeArquivo : 'arquivo';
  const nomeSeguro = nome.replace(/["\\\r\n]/g, '_');
  return 'attachment; filename="' + nomeSeguro + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome);
}

exports.handler = async (event) => {
  try {
    connectLambda(event);
    const store = getStore(STORE_NAME);

    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204 };
    }

    if (event.httpMethod === 'POST') {
      const payload = event.body ? JSON.parse(event.body) : {};
      const nome = typeof payload.nome === 'string' ? payload.nome.trim() : '';
      const tipo = typeof payload.tipo === 'string' ? payload.tipo : '';
      const conteudoBase64 = typeof payload.conteudoBase64 === 'string' ? payload.conteudoBase64 : '';
      const processoId = normalizarSegmento(payload.processoId, 'processo');

      if (!nome || !conteudoBase64) {
        return response(400, { erro: 'Dados do anexo inválidos.' });
      }
      if (!arquivoPermitido(nome)) {
        return response(400, { erro: 'Formato de arquivo não permitido.' });
      }

      const buffer = Buffer.from(conteudoBase64, 'base64');
      if (!buffer || buffer.length === 0) {
        return response(400, { erro: 'Arquivo vazio ou conteúdo inválido.' });
      }

      const id = gerarId();
      const storageKey = processoId + '/' + id + '-' + normalizarSegmento(nome, 'arquivo');
      const enviadoEm = new Date().toISOString();
      await store.set(storageKey, buffer, {
        metadata: {
          id,
          nome,
          tipo,
          tamanho: buffer.length,
          enviadoEm
        }
      });

      return response(200, {
        id,
        nome,
        tipo,
        tamanho: buffer.length,
        enviadoEm,
        storageKey
      });
    }

    if (event.httpMethod === 'GET') {
      const query = event.queryStringParameters || {};
      const storageKey = typeof query.key === 'string' ? query.key : '';
      if (!storageKey) {
        return response(400, { erro: 'Informe a chave do anexo.' });
      }

      const resultado = await store.getWithMetadata(storageKey, { type: 'arrayBuffer' });
      if (!resultado || !resultado.data) {
        return response(404, { erro: 'Anexo não encontrado.' });
      }

      const dataBuffer = Buffer.from(resultado.data);
      const meta = resultado.metadata || {};
      const nome = typeof query.nome === 'string' && query.nome ? query.nome : (typeof meta.nome === 'string' ? meta.nome : 'arquivo');
      const tipo = typeof meta.tipo === 'string' && meta.tipo ? meta.tipo : 'application/octet-stream';

      return {
        statusCode: 200,
        isBase64Encoded: true,
        headers: {
          'Content-Type': tipo,
          'Content-Disposition': montarContentDisposition(nome),
          'Cache-Control': 'private, no-store'
        },
        body: dataBuffer.toString('base64')
      };
    }

    if (event.httpMethod === 'DELETE') {
      const query = event.queryStringParameters || {};
      let storageKey = typeof query.key === 'string' ? query.key : '';
      if (!storageKey && event.body) {
        const payload = JSON.parse(event.body);
        if (payload && typeof payload.key === 'string') storageKey = payload.key;
      }
      if (!storageKey) {
        return response(400, { erro: 'Informe a chave do anexo para exclusão.' });
      }

      await store.delete(storageKey);
      return response(200, { ok: true });
    }

    return response(405, { erro: 'Método não permitido.' });
  } catch (err) {
    return response(500, { erro: 'Falha no gerenciamento de anexos.', detalhe: err && err.message ? err.message : 'Erro desconhecido.' });
  }
};
