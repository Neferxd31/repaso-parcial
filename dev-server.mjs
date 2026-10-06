// Solo para desarrollo local: sirve public/ y ejecuta la misma función que usa Netlify.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import handler from './netlify/functions/quiz.mjs';

const port = 3000;

http
  .createServer(async (req, res) => {
    if (req.url === '/api/quiz' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;

      // Netlify responde 500 si la función lanza un error; aquí se imita para no tumbar el servidor.
      try {
        const response = await handler(new Request(`http://localhost${req.url}`, { method: 'POST', body }));
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(await response.text());
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Error del servidor: ${error.message}` }));
      }
      return;
    }

    const html = await readFile('public/index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  })
  .listen(port, () => console.log(`Listo en http://localhost:${port}`));
