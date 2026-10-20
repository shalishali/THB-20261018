// 支付异步通知（公开路由，无 JWT）：支付宝/微信服务器回调。
// 安全边界：只接受验签通过、金额/商户/订单匹配的回调；入账复用 markQuotaOrderPaid 的幂等事务。
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createRateLimit, clientIp } from '../auth/rateLimit';
import { PaymentError, processAlipayNotify, processWechatNotify } from '../payment/service';

type RawRequest = FastifyRequest & { rawBody?: string };

export async function paymentPublicRoutes(app: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  const prisma = (app as unknown as { prisma: PrismaClient }).prisma;
  const notifyRateLimit = createRateLimit({ name: 'payment-notify', windowMs: 60_000, max: 300, keyBy: 'ip' });

  // 捕获原始报文：支付宝验签需要未经重排的表单参数，微信用原始 JSON 串验签。
  app.addHook('preParsing', async (request, _reply, payload) => {
    const chunks: Buffer[] = [];
    for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    (request as RawRequest).rawBody = raw.toString('utf8');
    return Readable.from(raw);
  });

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    } catch (error) {
      done(error as Error);
    }
  });

  app.post('/payment/alipay/notify', { onRequest: notifyRateLimit }, async (request, reply) => {
    const params = (request.body || {}) as Record<string, string>;
    try {
      await processAlipayNotify(prisma, params);
      return reply.type('text/plain').send('success');
    } catch (error) {
      request.log.warn({ err: error, ip: clientIp(request) }, 'alipay notify rejected');
      reply.code(error instanceof PaymentError && error.statusCode === 503 ? 503 : 400);
      return reply.type('text/plain').send('failure');
    }
  });

  app.post('/payment/wechat/notify', { onRequest: notifyRateLimit }, async (request, reply) => {
    const headers = {
      timestamp: String(request.headers['wechatpay-timestamp'] || ''),
      nonce: String(request.headers['wechatpay-nonce'] || ''),
      signature: String(request.headers['wechatpay-signature'] || ''),
      serial: String(request.headers['wechatpay-serial'] || ''),
    };
    const rawBody = (request as RawRequest).rawBody || '';
    try {
      await processWechatNotify(prisma, headers, rawBody);
      return { code: 'SUCCESS', message: '成功' };
    } catch (error) {
      request.log.warn({ err: error, ip: clientIp(request) }, 'wechat notify rejected');
      reply.code(error instanceof PaymentError && error.statusCode === 503 ? 503 : 400);
      return { code: 'FAIL', message: error instanceof Error ? error.message : '支付回调处理失败' };
    }
  });
}
