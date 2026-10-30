import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Создаёт минимальное Fastify-приложение для проверки базовой зависимости.
 * Маршруты и бизнес-логика будут добавлены в последующих задачах плана.
 */
export function createApp(): FastifyInstance {
  return Fastify();
}

export function main(): void {
  createApp();
}

main();
