// VERIFY AGAINST PAYWAY SANDBOX
// Every PayWay endpoint, field name and hash order lives in this file. The API docs were not reachable
// when this was written; it follows the published Checkout / QR API. Run docs/PAYWAY-SANDBOX-CHECKLIST.md
// with sandbox credentials and correct anything here.

export const PAYWAY_PATHS = {
  qr: '/api/payment-gateway/v1/payments/generate-qr',
  purchase: '/api/payment-gateway/v1/payments/purchase',
  check: '/api/payment-gateway/v1/payments/check-transaction-2',
  close: '/api/payment-gateway/v1/payments/close-transaction',
} as const;

/** Hash order for the KHQR request. */
export const QR_FIELDS = [
  'req_time',
  'merchant_id',
  'tran_id',
  'amount',
  'items',
  'first_name',
  'last_name',
  'email',
  'phone',
  'purchase_type',
  'payment_option',
  'callback_url',
  'return_deeplink',
  'currency',
  'custom_fields',
  'return_params',
  'payout',
  'lifetime',
  'qr_image_template',
] as const;

/** Hash order for the hosted card checkout (purchase API). */
export const PURCHASE_FIELDS = [
  'req_time',
  'merchant_id',
  'tran_id',
  'amount',
  'items',
  'shipping',
  'firstname',
  'lastname',
  'email',
  'phone',
  'type',
  'payment_option',
  'return_url',
  'cancel_url',
  'continue_success_url',
  'return_deeplink',
  'currency',
  'custom_fields',
  'return_params',
  'payout',
  'lifetime',
  'additional_params',
  'google_pay_token',
  'skip_success_page',
] as const;

/** Hash order for check-transaction and close-transaction. */
export const CHECK_FIELDS = ['req_time', 'merchant_id', 'tran_id'] as const;

/** PayWay payment_status → our provider status. */
export const STATUS_MAP: Record<string, 'pending' | 'approved' | 'declined' | 'refunded' | 'cancelled'> = {
  APPROVED: 'approved',
  PRE_AUTH: 'pending',
  PENDING: 'pending',
  DECLINED: 'declined',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled',
};

/** Pushback `status`: "0" means the payment succeeded. */
export const PUSHBACK_SUCCESS = '0';
/** Fields of the pushback that a hash, when PayWay sends one, covers (in order). */
export const PUSHBACK_HASH_FIELDS = ['tran_id', 'apv', 'status'] as const;
export const QR_IMAGE_TEMPLATE = 'template3_color';
