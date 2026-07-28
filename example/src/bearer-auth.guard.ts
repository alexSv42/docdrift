import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

/** Auth is `Authorization: Bearer <token>`. The old `X-Api-Key` header was dropped in v2. */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<{ headers: Record<string, string> }>()
      .headers['authorization'];
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Expected Authorization: Bearer <token>');
    }
    return true;
  }
}
