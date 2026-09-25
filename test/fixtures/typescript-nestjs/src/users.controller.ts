import { Controller, Get, Post, UseGuards } from '@nestjs/common';

@Controller('users')
@UseGuards(AuthGuard)
export class UsersController {
  @Get(':id')
  findOne() {
    return null;
  }

  @Post()
  @Roles('admin')
  async create() {
    return null;
  }
}
