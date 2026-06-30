// Worker: статика дашборда (ASSETS) + /briefing.json із KV (бот пише KV щодня,
// без щоденного редеплою). Той самий Worker згодом отримає API для A2-інтерактиву.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/briefing.json') {
      const data = await env.BRIEFING.get('latest');
      return new Response(data ?? '{}', {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        },
      });
    }
    return env.ASSETS.fetch(request); // статичні файли (дашборд)
  },
};
