import type { RequestHandler } from 'express';

export const checkJwt: RequestHandler = (req, res, next) => {
  if (req.header('x-token') === 'ok') {
    next();
    return;
  }
  res.sendStatus(401);
};

export const checkRole = (_roles: string[], _strict = false): RequestHandler => (_req, _res, next) => next();
