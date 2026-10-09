const ok = (_req, res) => {
  res.status(200).json({ ok: true });
};

export const listUsers = ok;
export const getUser = ok;
export const updateUser = ok;
export const searchOrders = ok;
export const getOrder = ok;
