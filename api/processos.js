const STORE_KEY = 'gestao-novos-processos:processos-json';

function enviarJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(body));
}

function obterPayload(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return req.body;
}

async function executarComandoKV(comando) {
  const baseUrl = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!baseUrl || !token) {
    throw new Error('KV não configurado no Vercel. Defina KV_REST_API_URL e KV_REST_API_TOKEN.');
  }

  const url = `${baseUrl}/${comando.map(parte => encodeURIComponent(String(parte))).join('/')}`;
  const resposta = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await resposta.json();
  if (!resposta.ok || payload.error) {
    throw new Error(payload.error || `Falha KV (${resposta.status}).`);
  }
  return payload.result;
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    if (req.method === 'GET') {
      const bruto = await executarComandoKV(['GET', STORE_KEY]);
      if (!bruto) {
        enviarJson(res, 200, { processos: [], processoAtualId: null, versao: 2 });
        return;
      }
      enviarJson(res, 200, JSON.parse(bruto));
      return;
    }

    if (req.method === 'PUT') {
      const payload = obterPayload(req);
      await executarComandoKV(['SET', STORE_KEY, JSON.stringify(payload)]);
      enviarJson(res, 200, { ok: true });
      return;
    }

    enviarJson(res, 405, { erro: 'Método não permitido.' });
  } catch (err) {
    enviarJson(res, 500, {
      erro: 'Falha na persistência dos processos.',
      detalhe: err && err.message ? err.message : 'Erro desconhecido.',
    });
  }
};
