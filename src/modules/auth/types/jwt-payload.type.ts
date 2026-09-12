import type { StaffRole } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  email: string;
  role: StaffRole;
}
