const EXTENSOES_PERMITIDAS = ['pdf', 'xls', 'xlsx', 'ppt', 'pptx'];
const PREFIXO_CHAVE = 'gestao-novos-processos:anexo:';

function enviarJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(body));
}

function gerarId() {
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function obterExtensaoArquivo(nomeArquivo) {
  if (!nomeArquivo || typeof nomeArquivo !== 'string') return '';
  const partes = nomeArquivo.toLowerCase().split('.');
  return partes.length > 1 ? partes.pop() : '';
}

function arquivoPermitido(nomeArquivo) {
  return EXTENSOES_PERMITIDAS.includes(obterExtensaoArquivo(nomeArquivo));
}

function normalizarSegmento(texto, fallback) {
  const valor = (texto || fallback || 'arquivo').toString();
  return valor.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || fallback || 'arquivo';
}

function montarContentDisposition(nomeArquivo) {
  const nome = typeof nomeArquivo === 'string' && nomeArquivo ? nomeArquivo : 'arquivo';
  const nomeSeguro = nome.replace(/["\\\r\n]/g, '_');
  return `attachment; filename="${nomeSeguro}"; filename*=UTF-8''${encodeURIComponent(nome)}`;
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

function obterPayload(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return req.body;
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    if (req.method === 'POST') {
      const payload = obterPayload(req);
      const nome = typeof payload.nome === 'string' ? payload.nome.trim() : '';
      const tipo = typeof payload.tipo === 'string' ? payload.tipo : '';
      const conteudoBase64 = typeof payload.conteudoBase64 === 'string' ? payload.conteudoBase64 : '';
      const processoId = normalizarSegmento(payload.processoId, 'processo');

      if (!nome || !conteudoBase64) {
        enviarJson(res, 400, { erro: 'Dados do anexo inválidos.' });
        return;
      }
      if (!arquivoPermitido(nome)) {
        enviarJson(res, 400, { erro: 'Formato de arquivo não permitido.' });
        return;
      }

      const buffer = Buffer.from(conteudoBase64, 'base64');
      if (!buffer || buffer.length === 0) {
        enviarJson(res, 400, { erro: 'Arquivo vazio ou conteúdo inválido.' });
        return;
      }

      const id = gerarId();
      const storageKey = `${processoId}/${id}-${normalizarSegmento(nome, 'arquivo')}`;
      const enviadoEm = new Date().toISOString();
      const registro = {
        id,
        nome,
        tipo,
        tamanho: buffer.length,
        enviadoEm,
        dataBase64: buffer.toString('base64'),
      };

      await executarComandoKV(['SET', `${PREFIXO_CHAVE}${storageKey}`, JSON.stringify(registro)]);
      enviarJson(res, 200, { id, nome, tipo, tamanho: buffer.length, enviadoEm, storageKey });
      return;
    }

    if (req.method === 'GET') {
      const storageKey = typeof req.query.key === 'string' ? req.query.key : '';
      if (!storageKey) {
        enviarJson(res, 400, { erro: 'Informe a chave do anexo.' });
        return;
      }

      const bruto = await executarComandoKV(['GET', `${PREFIXO_CHAVE}${storageKey}`]);
      if (!bruto) {
        enviarJson(res, 404, { erro: 'Anexo não encontrado.' });
        return;
      }

      const registro = JSON.parse(bruto);
      const nome = typeof req.query.nome === 'string' && req.query.nome ? req.query.nome : (registro.nome || 'arquivo');
      const tipo = typeof registro.tipo === 'string' && registro.tipo ? registro.tipo : 'application/octet-stream';
      const arquivoBuffer = Buffer.from(registro.dataBase64 || '', 'base64');

      res.status(200);
      res.setHeader('Content-Type', tipo);
      res.setHeader('Content-Disposition', montarContentDisposition(nome));
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(arquivoBuffer);
      return;
    }

    if (req.method === 'DELETE') {
      let storageKey = typeof req.query.key === 'string' ? req.query.key : '';
      if (!storageKey && req.body) {
        const payload = obterPayload(req);
        if (payload && typeof payload.key === 'string') storageKey = payload.key;
      }
      if (!storageKey) {
        enviarJson(res, 400, { erro: 'Informe a chave do anexo para exclusão.' });
        return;
      }

      await executarComandoKV(['DEL', `${PREFIXO_CHAVE}${storageKey}`]);
      enviarJson(res, 200, { ok: true });
      return;
    }

    enviarJson(res, 405, { erro: 'Método não permitido.' });
  } catch (err) {
    enviarJson(res, 500, {
      erro: 'Falha no gerenciamento de anexos.',
      detalhe: err && err.message ? err.message : 'Erro desconhecido.',
    });
  }
};
