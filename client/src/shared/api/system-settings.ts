import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from './http';

export interface SystemSettings {
  systemName: string;
  logoDataUrl: string | null;
  /** 邀请推广文案（管理员可编辑；支持 {inviteCode}/{inviteUrl} 占位符） */
  invitePromoCopy?: string;
  /** 邀请推广海报（管理员上传的 data URL；为空则不展示） */
  invitePosterDataUrl?: string | null;
}

interface SystemSettingsResponse extends SystemSettings {
  success?: boolean;
  message?: string;
}

type SystemSettingsPatch = Partial<Pick<SystemSettings, 'systemName' | 'logoDataUrl' | 'invitePromoCopy' | 'invitePosterDataUrl'>>;

// 基本设置（系统名称 + Logo + 邀请推广文案 + 邀请海报）：GET 公开（登录页/推广页需要），PUT 仅管理员。
// 用 react-query 全局缓存（queryKey ['system-settings']），Sidebar/LoginPage/SettingsPage 共享。
export async function getSystemSettings(): Promise<SystemSettings> {
  const { data } = await http.get<SystemSettings>('/system-settings');
  return { systemName: data.systemName, logoDataUrl: data.logoDataUrl ?? null, invitePromoCopy: data.invitePromoCopy ?? '', invitePosterDataUrl: data.invitePosterDataUrl ?? null };
}

export function useSystemSettings() {
  return useQuery({
    queryKey: ['system-settings'],
    queryFn: getSystemSettings,
    staleTime: Infinity,
  });
}

export async function saveSystemSettings(payload: SystemSettingsPatch): Promise<SystemSettings> {
  const { data } = await http.put<SystemSettingsResponse>('/system-settings', payload);
  return { systemName: data.systemName, logoDataUrl: data.logoDataUrl ?? null, invitePromoCopy: data.invitePromoCopy ?? '', invitePosterDataUrl: data.invitePosterDataUrl ?? null };
}

export function useSaveSystemSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SystemSettingsPatch) => saveSystemSettings(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['system-settings'] }),
  });
}
