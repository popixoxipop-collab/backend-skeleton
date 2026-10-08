// fixture-pin: typeorm@0.3.31 case: tenant-scope
import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

@Entity('orders')
export class Order {
	@PrimaryGeneratedColumn()
	id!: number;

	@Index()
	@Column('varchar')
	tenantId!: string;
}
