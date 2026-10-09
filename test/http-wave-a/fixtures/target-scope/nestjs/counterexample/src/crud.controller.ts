import { Controller, Get, Post } from '@nestjs/common';

export function crudController(path: string) {
  @Controller(path)
  class CrudController {
    @Get()
    list() {
      return { path, list: [] };
    }

    @Post()
    create() {
      return { path };
    }
  }
  return CrudController;
}
