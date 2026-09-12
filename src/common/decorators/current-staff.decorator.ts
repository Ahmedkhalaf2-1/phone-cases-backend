import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedStaff } from '../../modules/auth/types/authenticated-staff.type';

export const CurrentStaff = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedStaff => {
    const request = ctx.switchToHttp().getRequest<Request & { user: AuthenticatedStaff }>();
    return request.user;
  },
);
