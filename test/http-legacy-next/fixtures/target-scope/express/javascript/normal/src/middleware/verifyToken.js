export const verifyToken = (req, res, next) => {
  if (req.header('x-token') === 'ok') {
    next();
    return;
  }
  res.sendStatus(401);
};

export const requireRole = (_roles, _strict = false) => (_req, _res, next) => next();
