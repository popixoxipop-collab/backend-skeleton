import { Request, Response } from 'express';
import { AppDataSource } from '../../data-source';
import { User } from 'orm/entities/User';

export const show = async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== 'string') {
    res.status(400).json({ detail: 'malformed id path segment' });
    return;
  }
  // The real oracle's own only protection against leaking a column the app never otherwise
  // exposes (e.g. hashedPassword below): a hand-written select allow-list literal, not TypeORM's
  // real { select: false } column option (which the real oracle doesn't use either).
  const user = await AppDataSource.getRepository(User).findOne({
    where: { id },
    select: ['id', 'username', 'name', 'email'],
  });
  res.json(user);
};
