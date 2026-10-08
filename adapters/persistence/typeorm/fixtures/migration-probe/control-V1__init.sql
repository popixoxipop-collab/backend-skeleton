-- fixture-pin: typeorm@0.3.31 case: migration-probe (positive control: the same statement in a Flyway layout)
CREATE TABLE "account" ("id" SERIAL NOT NULL, "fullName" character varying NOT NULL, CONSTRAINT "PK_account_id" PRIMARY KEY ("id"));
