/** Static map viewer only: no database, application secrets or API routes. */
export default {
  /** @param {Request} request @param {{ASSETS:{fetch:(request:Request)=>Promise<Response>}}} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    if (!['/travel-map.html', '/travel-map-frame.js'].includes(url.pathname))
      return new Response('Not found', { status: 404 });
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    response.headers.set(
      'Content-Security-Policy',
      "frame-ancestors 'self' https://svitanok.yushko.dev https://web.telegram.org",
    );
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Origin-Agent-Cluster', '?1');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.headers.set('Cache-Control', 'public, max-age=300');
    return response;
  },
};
