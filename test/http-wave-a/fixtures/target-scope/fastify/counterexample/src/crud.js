export function crud(resource) {
  return async function crudPlugin(fastify) {
    fastify.get('/', async () => ({ resource, list: [] }));
    fastify.post('/', async (request, reply) => reply.code(201).send({ resource }));
  };
}
