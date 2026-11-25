declare global {
  namespace Express {
    interface Request {
      /** Correlation id set by the requestId middleware. */
      id: string;
      /** Raw request body bytes, kept for webhook signature checks. */
      rawBody?: Buffer;
    }
  }
}

export {};
