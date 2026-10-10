// fixture-pin: sequelize@6.37.8 case: migration-probe
'use strict';

module.exports = {
	async up(queryInterface, Sequelize) {
		await queryInterface.createTable('users', {
			id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
			email: { type: Sequelize.STRING, allowNull: false },
		});
	},

	async down(queryInterface) {
		await queryInterface.dropTable('users');
	},
};
