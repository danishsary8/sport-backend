import { describe, expect, it } from 'vitest';
import { render, type OrderNotice } from '../../src/modules/notifications/templates.js';

const notice: OrderNotice = {
  number: 'SC-2611-7Q4K9',
  status: 'confirmed',
  totalCents: 5250,
  totalKhr: 215300,
  contactName: '<script>x</script>',
  contactPhone: '+85512345678',
  contactChannel: 'telegram',
  fulfillment: 'delivery',
  items: [{ name: 'Cambodia Home Jersey', size: 'M', qty: 2 }],
};

describe('notification templates', () => {
  it('writes a payment-received email with the number and total, escaped', () => {
    const m = render('payment_received', notice, 'email');
    expect(m.subject).toContain('SC-2611-7Q4K9');
    expect(m.text).toContain('$52.50');
    expect(m.html).toContain('$52.50');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
  });

  it('marks refund alerts as urgent for ops', () => {
    const m = render('needs_refund', { ...notice, reason: 'paid after expiry; stock gone' }, 'telegram');
    expect(m.text.startsWith('🔴 URGENT')).toBe(true);
    expect(m.text).toContain('paid after expiry');
  });

  it('gives ops the contact details and items for a new order', () => {
    const m = render('order_placed', notice, 'telegram');
    expect(m.text).toContain('+85512345678');
    expect(m.text).toContain('telegram');
    expect(m.text).toContain('Cambodia Home Jersey (M) × 2');
  });

  it('tells the customer the new status in plain words', () => {
    expect(render('status_changed', { ...notice, status: 'out_for_delivery' }, 'email').text).toContain('out for delivery');
  });
});
