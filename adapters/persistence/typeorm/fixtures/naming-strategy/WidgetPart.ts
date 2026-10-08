// fixture-pin: typeorm@0.3.31 case: naming-strategy
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class WidgetPart {
	@PrimaryGeneratedColumn()
	id!: number;

	@Column('varchar')
	partName!: string;
}
