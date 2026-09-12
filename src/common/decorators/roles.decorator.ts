import { SetMetadata } from '@nestjs/common';
import { StaffRole } from '@prisma/client';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: StaffRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
