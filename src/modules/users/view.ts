import type { UserRow } from '../../db/schema/index.js';

export interface UserView {
  id: string;
  phone: string | null;
  email: string | null;
  fullName: string | null;
  photoUrl: string | null;
  role: UserRow['role'];
  staffBranchId: string | null;
  homeBranchId: string | null;
  preferredBootSize: string | null;
  preferredJerseySize: string | null;
  phoneVerified: boolean;
  createdAt: string;
}

export function toUserView(u: UserRow): UserView {
  return {
    id: u.id,
    phone: u.phoneE164,
    email: u.email,
    fullName: u.fullName,
    photoUrl: u.photoUrl,
    role: u.role,
    staffBranchId: u.staffBranchId,
    homeBranchId: u.homeBranchId,
    preferredBootSize: u.preferredBootSize,
    preferredJerseySize: u.preferredJerseySize,
    // Phone numbers only ever come from Firebase phone verification.
    phoneVerified: u.phoneE164 !== null,
    createdAt: u.createdAt.toISOString(),
  };
}
