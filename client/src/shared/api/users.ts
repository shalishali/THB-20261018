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
