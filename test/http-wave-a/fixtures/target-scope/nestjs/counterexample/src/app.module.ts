import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AdminModule } from './admin.module.js';
import { crudController } from './crud.controller.js';
import { GeneratedController } from './generated.controller.js';
import { OpenController } from './open.controller.js';
import { SecureController } from './secure.controller.js';

@Module({
  imports: [AdminModule, RouterModule.register([{ path: 'admin', module: AdminModule }])],
  controllers: [OpenController, SecureController, GeneratedController, crudController('widgets')],
})
export class AppModule {}
