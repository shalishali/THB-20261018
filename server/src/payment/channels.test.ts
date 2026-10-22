import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnabledQuotaChannels, isQuotaChannelEnabled } from '../quota/service';

test('支付渠道默认只开放支付宝，可通过 PAYMENT_CHANNELS 显式开启微信', () => {
  const previous = process.env.PAYMENT_CHANNELS;
  try {
    delete process.env.PAYMENT_CHANNELS;
    assert.deepEqual(getEnabledQuotaChannels(), ['alipay']);
    assert.equal(isQuotaChannelEnabled('alipay'), true);
    assert.equal(isQuotaChannelEnabled('wechat'), false);

    process.env.PAYMENT_CHANNELS = ' wechat, alipay,wechat,unknown ';
    assert.deepEqual(getEnabledQuotaChannels(), ['wechat', 'alipay']);
    assert.equal(isQuotaChannelEnabled('wechat'), true);
    assert.equal(isQuotaChannelEnabled('alipay'), true);

    process.env.PAYMENT_CHANNELS = 'unknown';
    assert.deepEqual(getEnabledQuotaChannels(), ['alipay']);
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_CHANNELS;
    else process.env.PAYMENT_CHANNELS = previous;
  }
});
