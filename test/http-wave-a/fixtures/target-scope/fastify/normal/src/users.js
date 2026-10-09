export default async function users(fastify) {
  fastify.get('/', async () => []);
  fastify.post('/', async (request, reply) => reply.code(201).send({ created: true }));
  fastify.get('/:id', async (request) => ({ id: request.params.id }));
}
