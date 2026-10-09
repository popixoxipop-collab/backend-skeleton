import { Controller, Delete, Get, Param, Post } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get()
  list() {
    return [];
  }

  @Post()
  create() {
    return { created: true };
  }

  @Get(':id')
  show(@Param('id') id: string) {
    return { id };
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return { removed: id };
  }
}
