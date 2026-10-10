// fixture-pin: typeorm@0.3.31 case: drift-v2
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('accounts')
export class Account {
	@PrimaryGeneratedColumn()
	id!: number;

	@Column('varchar', { nullable: true })
	displayName!: string | null;
}
