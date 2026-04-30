import { list, put } from '@vercel/blob';

const BLOB_STATE_PATH = 'gestao-processos/app-state.json';

function getBlobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function lerEstadoBlob() {
  const token = getBlobToken();
  const { blobs } = await list({ prefix: BLOB_STATE_PATH, token, limit: 10 });
  const blob = blobs.find(b => b.pathname === BLOB_STATE_PATH);
  if (!blob) return null;
  const res = await fetch(blob.downloadUrl);
  if (!res.ok) return null;
  return res.json();
}

async function gravarEstadoBlob(data) {
  const token = getBlobToken();
  await put(BLOB_STATE_PATH, JSON.stringify(data), {
    access: 'public',
    addRandomSuffix: false,
    token,
    contentType: 'application/json'
  });
}

export async function GET() {
  if (!getBlobToken()) {
    return json(
      {
        error: 'STORAGE_NOT_CONFIGURED',
        message: 'Configure a variável BLOB_READ_WRITE_TOKEN no projeto para usar o Vercel Blob.'
      },
      503
    );
  }
  try {
    const data = await lerEstadoBlob();
    return json(data ?? null);
  } catch (e) {
    console.error('[api/state GET]', e);
    return json(
      {
        error: 'STORAGE_UNAVAILABLE',
        message: e instanceof Error ? e.message : String(e)
      },
      503
    );
  }
}

export async function POST(request) {
  if (!getBlobToken()) {
    return json(
      {
        error: 'STORAGE_NOT_CONFIGURED',
        message: 'Configure a variável BLOB_READ_WRITE_TOKEN nas definições do projeto na Vercel.'
      },
      503
    );
  }
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'INVALID_JSON' }, 400);
    }
    if (!body || typeof body !== 'object') {
      return json({ error: 'INVALID_BODY' }, 400);
    }
    await gravarEstadoBlob(body);
    return json({ ok: true });
  } catch (e) {
    console.error('[api/state POST]', e);
    return json(
      {
        error: 'STORAGE_UNAVAILABLE',
        message: e instanceof Error ? e.message : String(e)
      },
      503
    );
  }
}
