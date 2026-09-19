import { SetMetadata } from '@nestjs/common';

export type UserRole = 'patient' | 'doctor' | 'admin';
export const ROLES_KEY = 'roles';

/** Restrict access to users with the specified role(s). */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
