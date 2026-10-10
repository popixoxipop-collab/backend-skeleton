// fixture-pin: typeorm@0.3.31 case: relation
import { Entity, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';

@Entity('authors')
export class Author {
	@PrimaryGeneratedColumn()
	id!: number;
}

@Entity('posts')
export class Post {
	@PrimaryGeneratedColumn()
	id!: number;

	@ManyToOne(() => Author)
	@JoinColumn({ name: 'author_id' })
	author!: Author;
}
