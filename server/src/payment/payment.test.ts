import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildAlipayPagePayUrl, parseAlipayNotify, signAlipayNotifyForTest } from './alipay';
import { parseWechatNotify, signWechatNotifyForTest } from './wechat';
import type { AlipayConfig, WechatConfig } from './config';

function rsaPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, publicKey };
}

test('支付宝：收银台 URL 带 RSA2 签名，通知验签通过且可拒绝篡改', () => {
  const appKeys = rsaPair();
  const alipayKeys = rsaPair();
  const config: AlipayConfig = {
    appId: '2026000000000001',
    privateKey: appKeys.privateKey,
    alipayPublicKey: alipayKeys.publicKey,
    gateway: 'https://openapi.alipay.com/gateway.do',
    notifyUrl: 'https://example.com/api/payment/alipay/notify',
    returnUrl: 'https://example.com/?recharge=done',
  };
  const url = buildAlipayPagePayUrl(config, { outTradeNo: 'QTEST001', amountCents: 390, subject: '投好标充值 plan-10w' });
  const parsedUrl = new URL(url);
  assert.ok(parsedUrl.searchParams.get('sign'));
  assert.equal(parsedUrl.searchParams.get('app_id'), config.appId);
  assert.equal(parsedUrl.searchParams.get('sign_type'), 'RSA2');
  const biz = JSON.parse(parsedUrl.searchParams.get('biz_content') || '{}');
  assert.equal(biz.out_trade_no, 'QTEST001');
  assert.equal(biz.total_amount, '3.90');

  const notify: Record<string, string> = {
    app_id: config.appId,
    out_trade_no: 'QTEST001',
    total_amount: '3.90',
    trade_status: 'TRADE_SUCCESS',
    sign_type: 'RSA2',
  };
  notify.sign = signAlipayNotifyForTest(alipayKeys.privateKey, notify);
  const ok = parseAlipayNotify(config, notify);
  assert.ok(ok);
  assert.equal(ok?.amountCents, 390);
  assert.equal(ok?.outTradeNo, 'QTEST001');

  const tampered = { ...notify, total_amount: '0.01' };
  assert.equal(parseAlipayNotify(config, tampered), null);
});

test('微信：Native 回调验签 + AES-256-GCM 解密，拒绝篡改报文', () => {
  const platformKeys = rsaPair();
  const apiV3Key = '0123456789abcdef0123456789abcdef';
  const config: WechatConfig = {
    mchId: '1900000001',
    appId: 'wx1234567890',
    apiV3Key,
    certSerialNo: 'MERCHANT-SERIAL',
    privateKey: rsaPair().privateKey,
    platformPublicKey: platformKeys.publicKey,
    platformSerialNo: '',
    notifyUrl: 'https://example.com/api/payment/wechat/notify',
  };
  const transaction = JSON.stringify({
    out_trade_no: 'QTEST002',
    amount: { total: 390 },
    mchid: config.mchId,
    appid: config.appId,
    trade_state: 'SUCCESS',
  });
  const nonce = 'notify-nonce';
  const aad = 'transaction';
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(nonce, 'utf8'));
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(transaction, 'utf8'), cipher.final()]);
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');
  const rawBody = JSON.stringify({
    event_type: 'TRANSACTION.SUCCESS',
    resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext, nonce, associated_data: aad },
  });
  const timestamp = '1700000000';
  const headerNonce = 'header-nonce';
  const signature = signWechatNotifyForTest(platformKeys.privateKey, timestamp, headerNonce, rawBody);
  const headers = { timestamp, nonce: headerNonce, signature, serial: '' };

  const parsed = parseWechatNotify(config, headers, rawBody);
  assert.ok(parsed);
  assert.equal(parsed?.outTradeNo, 'QTEST002');
  assert.equal(parsed?.amountCents, 390);
  assert.equal(parsed?.tradeState, 'SUCCESS');

  assert.equal(parseWechatNotify(config, headers, rawBody.replace('TRANSACTION.SUCCESS', 'TRANSACTION.FAIL')), null);
});
