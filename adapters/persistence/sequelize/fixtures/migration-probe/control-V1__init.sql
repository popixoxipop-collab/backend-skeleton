-- fixture-pin: sequelize@6.37.8 case: migration-probe (positive control: the same table in a Flyway layout)
CREATE TABLE users (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL);
