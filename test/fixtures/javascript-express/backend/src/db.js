// No ORM anywhere in this fixture, by design -- a raw `mysql2/promise` pool, exactly the shape
// G6's real target app uses. There is no @Entity, no model class, no schema metadata of any kind
// for a scanner to read: the ONLY description of this app's tables and columns is the SQL string
// literals inside the controllers.
import mysql from 'mysql2/promise';

export const pool = mysql.createPool({
	host: process.env.DB_HOST,
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
	waitForConnections: true,
	connectionLimit: 10,
});
