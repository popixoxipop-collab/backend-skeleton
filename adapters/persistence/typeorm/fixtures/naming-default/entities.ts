// fixture-pin: typeorm@0.3.31 case: naming-default
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class Account {
	@PrimaryGeneratedColumn()
	id!: number;
}

@Entity()
export class UserAccount {
	@PrimaryGeneratedColumn()
	id!: number;

	@Column('varchar')
	displayName!: string;
}
