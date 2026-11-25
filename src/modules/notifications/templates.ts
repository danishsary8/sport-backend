export type Template = 'order_placed' | 'payment_received' | 'status_changed' | 'needs_refund' | 'payment_unverified' | 'rma_requested' | 'rma_decided' | 'question_received';

export interface OrderNotice {
  number: string;
  status: string;
  totalCents: number;
  totalKhr: number;
  contactName: string;
  contactPhone: string;
  contactChannel: string;
  fulfillment: string;
  items: { name: string; size: string; qty: number }[];
  reason?: string;
  rma?: { number: string; resolution: string; status: string; refundCents: number; decisionNote: string | null; itemCount: number };
  question?: { productName: string; authorName: string; text: string };
}

export function escapeHtml(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const riel = (khr: number) => `${khr.toLocaleString('en-US')}៛`;
const words = (status: string) => status.replaceAll('_', ' ');
const itemLines = (n: OrderNotice) => n.items.map((i) => `• ${i.name} (${i.size}) × ${i.qty}`);

const STATUS_COPY: Record<string, string> = {
  confirmed: 'Your order is confirmed and being prepared.',
  printing: 'Your shirt is being printed.',
  ready_for_pickup: 'Your order is ready to collect from the store.',
  out_for_delivery: 'Your order is out for delivery.',
  delivered: 'Your order has been delivered.',
  completed: 'Your order is complete. Thank you!',
  cancelled: 'Your order was cancelled.',
  expired: 'Your order expired because payment was not received in time.',
};

/** Plain, short messages; HTML is escaped and only used for email. */
export function render(template: Template, n: OrderNotice, channel: 'telegram' | 'email'): { subject: string; text: string; html?: string } {
  let subject: string;
  let lines: string[];
  switch (template) {
    case 'order_placed':
      subject = `New order ${n.number}`;
      lines = [
        `🛒 New order ${n.number} (awaiting payment)`,
        `${usd(n.totalCents)} · ${riel(n.totalKhr)} · ${n.fulfillment}`,
        `Contact: ${n.contactName} ${n.contactPhone} via ${n.contactChannel}`,
        ...itemLines(n),
      ];
      break;
    case 'payment_received':
      subject = channel === 'email' ? `Payment received for order ${n.number}` : `Paid: ${n.number}`;
      lines =
        channel === 'email'
          ? [`Hi ${n.contactName},`, `We received your payment of ${usd(n.totalCents)} for order ${n.number}.`, ...itemLines(n), 'We will contact you when it is on its way.']
          : [`✅ Paid ${n.number}: ${usd(n.totalCents)} · ${n.fulfillment}`, `Contact: ${n.contactName} ${n.contactPhone} via ${n.contactChannel}`, ...itemLines(n)];
      break;
    case 'status_changed':
      subject = `Order ${n.number}: ${words(n.status)}`;
      lines = [`Hi ${n.contactName},`, STATUS_COPY[n.status] ?? `Your order ${n.number} is now ${words(n.status)}.`, `Order ${n.number} · status: ${words(n.status)}`];
      break;
    case 'rma_requested': {
      const r = n.rma!;
      subject = `Return request ${r.number}`;
      lines = [`↩️ Return request ${r.number} for order ${n.number}: ${words(r.resolution)}, ${r.itemCount} item(s)${r.refundCents ? `, ${usd(r.refundCents)}` : ''}.`, `Contact: ${n.contactName} ${n.contactPhone} via ${n.contactChannel}`];
      break;
    }
    case 'rma_decided': {
      const r = n.rma!;
      subject = `Your return ${r.number} was ${r.status}`;
      const what =
        r.status === 'approved'
          ? r.resolution === 'size_exchange'
            ? 'Your size exchange is approved; we will contact you to hand over the new size.'
            : r.resolution === 'store_credit'
              ? `Your return is approved; ${usd(r.refundCents)} store credit will be issued to you.`
              : `Your return is approved; ${usd(r.refundCents)} will be refunded to your original payment method.`
          : `Your return request was not accepted${r.decisionNote ? `: ${r.decisionNote}` : '.'}`;
      lines = [`Hi ${n.contactName},`, what, `Return ${r.number} · order ${n.number}`];
      break;
    }
    case 'question_received': {
      const qn = n.question!;
      subject = `New question: ${qn.productName}`;
      lines = [`❓ New product question on ${qn.productName} from ${qn.authorName}:`, qn.text, 'Answer it in the admin area.'];
      break;
    }
    case 'payment_unverified':
      subject = `⚠️ Check payment: ${n.number}`;
      lines = [`⚠️ Order ${n.number} expired but PayWay could not be reached to confirm it was unpaid.`, `Check ${usd(n.totalCents)} for this order in the PayWay portal; if it was paid, refund or contact the customer.`, `Contact: ${n.contactName} ${n.contactPhone} via ${n.contactChannel}`];
      break;
    case 'needs_refund':
      subject = `🔴 URGENT refund needed: ${n.number}`;
      lines = [`🔴 URGENT: order ${n.number} needs a refund (${usd(n.totalCents)}).`, `Reason: ${n.reason ?? 'see the order timeline'}`, `Contact: ${n.contactName} ${n.contactPhone} via ${n.contactChannel}`];
      break;
  }
  const text = lines.join('\n');
  if (channel !== 'email') return { subject, text };
  const html = `<div style="font-family:sans-serif">${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}<p>Sport Castle</p></div>`;
  return { subject, text, html };
}
