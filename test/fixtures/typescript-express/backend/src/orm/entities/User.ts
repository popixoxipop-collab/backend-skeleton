import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  email!: string;

  @Column()
  hashedPassword!: string;

  @Column({ nullable: true })
  username!: string;

  @Column({ nullable: true })
  name!: string;
}
