import { Controller, Get, Module } from '@nestjs/common';

@Controller('reports')
export class ReportsController {
  @Get()
  list() {
    return [];
  }
}

@Module({ controllers: [ReportsController] })
export class AdminModule {}
