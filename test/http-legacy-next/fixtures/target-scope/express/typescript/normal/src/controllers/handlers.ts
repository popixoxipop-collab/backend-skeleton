import type { RequestHandler } from 'express';

const ok: RequestHandler = (_req, res) => {
  res.status(200).json({ ok: true });
};

export const health = ok;
export const list = ok;
export const show = ok;
export const create = ok;
export const search = ok;
export const getOrder = ok;
