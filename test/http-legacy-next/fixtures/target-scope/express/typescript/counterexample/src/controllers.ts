import type { RequestHandler } from 'express';

export const handler: RequestHandler = (_req, res) => {
  res.status(200).json({ ok: true });
};
