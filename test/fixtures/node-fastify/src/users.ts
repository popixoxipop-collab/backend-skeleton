import type { FastifyPluginAsync } from 'fastify';

const users: FastifyPluginAsync = async (fastify) => {
  fastify.get('/users/:id', showUser);
  fastify.route({ method: 'POST', url: '/users', handler: createUser });
};

export default users;
