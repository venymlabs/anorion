// Full-text search API routes
import { Hono } from 'hono';
import { searchEngine } from '../search/engine';

const app = new Hono();

app.get('/api/v1/search', (c) => {
  const query = c.req.query('q') || '';
  if (!query) return c.json({ error: 'q parameter is required' }, 400);

  const agentId = c.req.query('agentId') || undefined;
  const sessionId = c.req.query('sessionId') || undefined;
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);

  const results = searchEngine.search({
    query,
    agentId,
    sessionId,
    limit,
  });

  return c.json({
    results,
    total: results.length,
    query,
  });
});

export default app;
