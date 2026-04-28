const { connectLambda, getStore } = require('@netlify/blobs');

const STORE_NAME = 'gestao-novos-processos';
const STORE_KEY = 'processos.json';

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    connectLambda(event);
    const store = getStore(STORE_NAME);

    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204 };
    }

    if (event.httpMethod === 'GET') {
      const data = await store.get(STORE_KEY, { type: 'json' });
      return response(200, data || { processos: [], processoAtualId: null, versao: 2 });
    }

    if (event.httpMethod === 'PUT') {
      const payload = event.body ? JSON.parse(event.body) : {};
      await store.setJSON(STORE_KEY, payload);
      return response(200, { ok: true });
    }

    return response(405, { erro: 'Método não permitido.' });
  } catch (err) {
    return response(500, { erro: 'Falha na persistência dos processos.', detalhe: err && err.message ? err.message : 'Erro desconhecido.' });
  }
};

