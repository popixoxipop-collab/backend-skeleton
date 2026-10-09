export default async function members(fastify) {
  fastify.get('/ping', async () => ({ pong: true }));
}
