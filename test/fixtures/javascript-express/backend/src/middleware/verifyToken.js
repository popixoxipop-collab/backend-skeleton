export const verifyToken = (req, _res, next) => {
	req.auth = { userUid: req.headers['x-user-uid'] ?? null };
	next();
};
