import { Controller, Get } from '@nestjs/common';

@Controller()
export class OpenController {
  @Get('open')
  open() {
    return 'open';
  }
}
