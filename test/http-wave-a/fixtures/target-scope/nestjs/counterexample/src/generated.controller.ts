import { Controller, Get } from '@nestjs/common';

const KIND = 'alpha';

@Controller('gen')
export class GeneratedController {
  @Get(`item/${KIND}`)
  item() {
    return { kind: KIND };
  }
}
