import { Request, Response, NextFunction } from 'express';

export function checkJwt(_req: Request, _res: Response, next: NextFunction): void {
  next();
}
