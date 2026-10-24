const functionPrefix = '/.netlify/functions/api-proxy';

export default async function handler(request) {
  const incomingUrl = new URL(request.url);
  const prefixIndex = incomingUrl.pathname.indexOf(functionPrefix);
  const apiPath = prefixIndex < 0 ? '' : incomingUrl.pathname.slice(prefixIndex + functionPrefix.length);
  if (!apiPath.startsWith('/api/')) return Response.json({ error: 'API route not found' }, { status: 404 });

  const browserOrigin = request.headers.get('origin');
  if (browserOrigin && new URL(browserOrigin).host !== incomingUrl.host) {
    return Response.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  }

  const configuredApi = process.env.CONNECT_API_URL;
  if (!configuredApi) return Response.json({ error: 'Connect API is not configured. Set CONNECT_API_URL in Netlify environment variables.' }, { status: 503 });

  let apiBase;
  try {
    apiBase = new URL(configuredApi);
  } catch {
    return Response.json({ error: 'CONNECT_API_URL must be a valid HTTPS URL' }, { status: 500 });
  }
  const localHttp = apiBase.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(apiBase.hostname);
  if ((apiBase.protocol !== 'https:' && !localHttp) || apiBase.pathname !== '/' || apiBase.search || apiBase.hash) {
    return Response.json({ error: 'CONNECT_API_URL must be an HTTPS origin without a path' }, { status: 500 });
  }

  const upstreamUrl = new URL(`${apiPath}${incomingUrl.search}`, apiBase);
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'cookie']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('origin', apiBase.origin);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
    });
    const responseHeaders = new Headers();
    for (const name of ['cache-control', 'content-type', 'set-cookie', 'www-authenticate']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set('x-content-type-options', 'nosniff');
    return new Response(['HEAD', '204', '304'].includes(request.method) || [204, 304].includes(upstream.status)
      ? null
      : await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return Response.json({ error: 'Could not reach the configured Connect API' }, { status: 502 });
  }
}