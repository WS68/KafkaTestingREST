import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';

/** Регистрирует машиночитаемую спецификацию OpenAPI и интерфейс Swagger UI. */
export const registerOpenApi: FastifyPluginAsync = fp(async (app) => {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Kafka Testing REST API',
        version: '0.0.0',
        description: 'HTTP-сервис для публикации и наблюдения записей Kafka.',
      },
      servers: [],
    },
  });

  app.get('/api-docs', { schema: { hide: true } }, async () => app.swagger());

  await app.register(swaggerUi, {
    routePrefix: '/api-docs/swagger-ui',
    uiConfig: {
      urls: [{ name: 'Kafka Testing REST API', url: '/api-docs' }],
    },
    uiHooks: {
      onRequest: async (request, reply) => {
        if (request.url.split('?')[0] === '/api-docs/swagger-ui/json') {
          reply.code(404);
          return reply.send();
        }
      },
    },
    transformSpecification: (specification) => specification,
  });
});
