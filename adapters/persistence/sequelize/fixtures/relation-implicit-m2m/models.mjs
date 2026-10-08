// fixture-pin: sequelize@6.37.8 case: relation-implicit-m2m
export default function define(sequelize, DataTypes) {
	const Post = sequelize.define('Post', {
		id: { type: DataTypes.INTEGER, primaryKey: true },
	}, { tableName: 'posts', timestamps: false });

	const Tag = sequelize.define('Tag', {
		id: { type: DataTypes.INTEGER, primaryKey: true },
	}, { tableName: 'tags', timestamps: false });

	Post.belongsToMany(Tag, { through: 'PostTags' });
	Tag.belongsToMany(Post, { through: 'PostTags' });
	return { Post, Tag };
}
