import { DataSource } from 'typeorm';
import { User } from 'orm/entities/User';

export const AppDataSource = new DataSource({
  type: 'postgres',
  entities: [User],
});
