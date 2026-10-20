import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { PrismaClient } from '@prisma/client';

// 无鉴权健康检查：给 PM2/Nginx/LB/监控使用。只暴露状态与时间，不泄露配置或业务数据。
export async function healthRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  app.get('/health', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'ok', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() };
    } catch {
      reply.code(503);
      return { status: 'error', db: 'unavailable', timestamp: new Date().toISOString() };
    }
  });
}
