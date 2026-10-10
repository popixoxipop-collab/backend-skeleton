// fixture-pin: typeorm@0.3.31 case: normal
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('users')
export class User {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column('varchar')
	email!: string;
}
