import { StaffRole } from '@prisma/client';

export interface AuthenticatedStaff {
  id: string;
  email: string;
  role: StaffRole;
}
