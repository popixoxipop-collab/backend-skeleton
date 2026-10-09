async function reports(fastify) {
  fastify.get('/reports', async () => []);
}

export default async function admin(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.headers['x-token']) reply.code(401).send({ error: 'unauthorized' });
  });
  fastify.get('/data', async () => ({ secret: true }));
  fastify.register(reports, { prefix: '/v1' }); // nested plugin with its own prefix
}
