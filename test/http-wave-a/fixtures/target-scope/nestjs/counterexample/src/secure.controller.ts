import { CanActivate, Controller, ExecutionContext, Get, Injectable, UnauthorizedException, UseGuards } from '@nestjs/common';

@Injectable()
export class TokenGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (!context.switchToHttp().getRequest().headers['x-token']) throw new UnauthorizedException();
    return true;
  }
}

@Controller('secure')
@UseGuards(TokenGuard)
export class SecureController {
  @Get('data')
  data() {
    return { secret: true };
  }
}
