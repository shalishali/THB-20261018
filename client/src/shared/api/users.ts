import { http } from './http';

// 用户实体（对齐 server routes/users.ts publicUser 返回）。
export interface SystemUser {
  id: number;
  username: string;
  displayName: string | null;
  phone: string | null;
  department: string | null;
  role: string;
  modules: string[];
  createdAt: string;
  /** 字数额度余额（可导出字数） */
  quotaChars?: number;
  /** 累计已用字数（导出扣减累计） */
  quotaUsedChars?: number;
  /** 累计充值金额（分，仅已核验订单） */
  totalRechargeCents?: number;
  /** 累计充值字数（仅已核验订单） */
  totalRechargeChars?: number;
}

export interface UsersListResult {
  users: SystemUser[];
}

export async function fetchUsers(): Promise<UsersListResult> {
  const { data } = await http.get<UsersListResult>('/users');
  return data;
}

export interface UserUpdatePatch {
  displayName?: string;
  department?: string;
  role?: string;
  modules?: string[];
  password?: string;
}

export async function updateUser(id: number, patch: UserUpdatePatch): Promise<void> {
  await http.put(`/users/${id}`, patch);
}

export async function deleteUser(id: number): Promise<void> {
  await http.delete(`/users/${id}`);
}
