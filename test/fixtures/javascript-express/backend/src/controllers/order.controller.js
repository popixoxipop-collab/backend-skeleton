// Phase 2 investigation material, the hard half. Three shapes that are entirely ordinary in real
// raw-SQL Express code and that each defeat a different part of a "read the SQL literal" heuristic:
//   getOrder      -- multi-table JOIN + `o.*` star projection + a backtick-quoted reserved-word
//                    table name + an aliased WHERE column
//   searchOrders  -- the query string is BUILT AT RUNTIME by concatenation; no single literal in
//                    this file ever contains the finished statement
//   countOrders   -- the statement lives in a shared constants module, not at the call site at all
import { pool } from '../db.js';
import { ORDER_COUNT_SQL } from './order.sql.js';

export const getOrder = async (req, res) => {
	const conn = await pool.getConnection();
	try {
		const sql = `
			SELECT o.*, u.nickname AS buyer_nickname
			FROM \`order\` o
			JOIN user u ON u.user_uid = o.user_uid
			WHERE o.order_id = ?
		`;
		const [rows] = await conn.execute(sql, [req.params.orderId]);
		if (rows.length === 0) {
			res.status(404).json({ message: 'order not found' });
			return;
		}
		res.json(rows[0]);
	} finally {
		conn.release();
	}
};

export const searchOrders = async (req, res) => {
	let sql = 'SELECT order_id, status, total_amount FROM `order` WHERE 1 = 1';
	const params = [];
	if (req.query.status) {
		sql += ' AND status = ?';
		params.push(req.query.status);
	}
	if (req.query.buyer) {
		sql += ' AND user_uid = ?';
		params.push(req.query.buyer);
	}
	sql += ' ORDER BY created_at DESC LIMIT 50';
	const [rows] = await pool.query(sql, params);
	res.json(rows);
};

export const countOrders = async (_req, res) => {
	const [rows] = await pool.query(ORDER_COUNT_SQL);
	res.json(rows[0]);
};
