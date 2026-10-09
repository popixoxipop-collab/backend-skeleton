import type { RequestHandler } from 'express';

export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.header('x-token') === 'ok') {
    next();
    return;
  }
  res.sendStatus(401);
};
