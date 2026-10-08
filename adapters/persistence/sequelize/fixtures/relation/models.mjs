// fixture-pin: sequelize@6.37.8 case: relation
export default function define(sequelize, DataTypes) {
	const Author = sequelize.define('Author', {
		id: { type: DataTypes.INTEGER, primaryKey: true },
	}, { tableName: 'authors', timestamps: false });

	const Post = sequelize.define('Post', {
		id: { type: DataTypes.INTEGER, primaryKey: true },
		authorId: { type: DataTypes.INTEGER, field: 'author_id' },
	}, { tableName: 'posts', timestamps: false });

	Author.hasMany(Post, { foreignKey: 'authorId' });
	Post.belongsTo(Author, { foreignKey: 'authorId' });
	return { Author, Post };
}
