export const requireAuth = (req, res, next) => {
  if (req.header('x-token') === 'ok') {
    next();
    return;
  }
  res.sendStatus(401);
};
