// fixture-pin: typeorm@0.3.31 case: migration-probe
import { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1700000000000 implements MigrationInterface {
	name = 'Init1700000000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`CREATE TABLE "account" ("id" SERIAL NOT NULL, "fullName" character varying NOT NULL, CONSTRAINT "PK_account_id" PRIMARY KEY ("id"))`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP TABLE "account"`);
	}
}
