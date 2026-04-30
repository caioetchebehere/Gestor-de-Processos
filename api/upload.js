import { put } from '@vercel/blob';

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

export async function POST(request) {
  const token = getBlobToken();
  if (!token) {
    return json(
      {
        error: 'STORAGE_NOT_CONFIGURED',
        message: 'Configure a variável BLOB_READ_WRITE_TOKEN nas definições do projeto na Vercel.'
      },
      503
    );
  }
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || typeof file !== 'object' || typeof file.arrayBuffer !== 'function') {
      return json({ error: 'FILE_REQUIRED' }, 400);
    }
    const rawName = typeof file.name === 'string' && file.name ? file.name : 'arquivo';
    const safe = rawName.replace(/[^\w.\- ()\[\]]+/g, '_').slice(0, 180);
    const pathname = `gestao-processos/anexos/${Date.now()}-${safe}`;
    const blob = await put(pathname, file, { access: 'public', token });
    return json({
      url: blob.url,
      pathname: blob.pathname,
      nome: rawName,
      size: typeof file.size === 'number' ? file.size : null
    });
  } catch (e) {
    console.error('[api/upload POST]', e);
    return json(
      {
        error: 'BLOB_UNAVAILABLE',
        message: e instanceof Error ? e.message : String(e)
      },
      503
    );
  }
}
