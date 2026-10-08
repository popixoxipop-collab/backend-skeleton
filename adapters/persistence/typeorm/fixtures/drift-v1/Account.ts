// fixture-pin: typeorm@0.3.31 case: drift-v1
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('accounts')
export class Account {
	@PrimaryGeneratedColumn()
	id!: number;

	@Column('varchar', { nullable: true })
	fullName!: string | null;
}
