import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { UsersController } from './users.controller.js';

@Module({ controllers: [HealthController, UsersController] })
export class AppModule {}
