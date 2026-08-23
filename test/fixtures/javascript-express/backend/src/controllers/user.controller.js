// Phase 2 investigation material (see D-javascript-express-adapter in DECISIONS.md). This is the
// FRIENDLIEST possible shape for a "parse the SQL literal" heuristic: single-table, explicit
// column list, one placeholder. Even here, `getUser`'s WHERE clause carries a second predicate
// (`deleted_at IS NULL`) and `listUsers`'s SELECT list is a DIFFERENT column set than `getUser`'s
// -- so "the columns this resource is safe to expose" is not one answer per table, it is one
// answer per call site.
import { pool } from '../db.js';

export const listUsers = async (_req, res) => {
	const [rows] = await pool.query(
		'SELECT user_uid, nickname FROM user WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100',
	);
	res.json(rows);
};

export const getUser = async (req, res) => {
	const { userUid } = req.params;
	const [rows] = await pool.query(
		'SELECT user_uid, nickname, profile_image_url, created_at FROM user WHERE user_uid = ? AND deleted_at IS NULL',
		[userUid],
	);
	if (rows.length === 0) {
		res.status(404).json({ message: 'user not found' });
		return;
	}
	res.json(rows[0]);
};

export const updateUser = async (req, res) => {
	const { userUid } = req.params;
	const { nickname } = req.body;
	await pool.execute('UPDATE user SET nickname = ?, updated_at = NOW() WHERE user_uid = ?', [nickname, userUid]);
	res.json({ ok: true });
};
