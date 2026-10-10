// fixture-pin: typeorm@0.3.31 case: pk-column-name
import { Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('profiles')
export class Profile {
	@PrimaryGeneratedColumn({ name: 'profile_id' })
	id!: number;
}
