import { Request, Response, NextFunction } from 'express';

export function checkRole(_roles: string[], _selfAllowed = false) {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  };
}
