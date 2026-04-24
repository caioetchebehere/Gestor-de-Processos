import { Redis } from '@upstash/redis';

const KEY = 'gestao-processos:estado';

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
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

export async function GET() {
  const redis = getRedis();
  if (!redis) {
    return json(
      {
        error: 'REDIS_NOT_CONFIGURED',
        message: 'Defina UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN (integração Redis na Vercel).'
      },
      503
    );
  }
  try {
    const data = await redis.get(KEY);
    return json(data ?? null);
  } catch (e) {
    console.error('[api/state GET]', e);
    return json(
      {
        error: 'REDIS_UNAVAILABLE',
        message: e instanceof Error ? e.message : String(e)
      },
      503
    );
  }
}

export async function POST(request) {
  const redis = getRedis();
  if (!redis) {
    return json(
      {
        error: 'REDIS_NOT_CONFIGURED',
        message: 'Defina UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN.'
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
    await redis.set(KEY, body);
    return json({ ok: true });
  } catch (e) {
    console.error('[api/state POST]', e);
    return json(
      {
        error: 'REDIS_UNAVAILABLE',
        message: e instanceof Error ? e.message : String(e)
      },
      503
    );
  }
}
