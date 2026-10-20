import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from './http';

export interface SystemSettings {
  systemName: string;
  logoDataUrl: string | null;
  /** 邀请推广文案（管理员可编辑；支持 {inviteCode}/{inviteUrl} 占位符） */
  invitePromoCopy?: string;
  /** 邀请推广海报（管理员上传的 data URL；为空则不展示） */
  invitePosterDataUrl?: string | null;
  /** 客服二维码（管理员上传；为空时侧栏使用内置默认图） */
  supportQrDataUrl?: string | null;
  /** 加群二维码（管理员上传；为空时展示占位提示） */
  groupQrDataUrl?: string | null;
}

interface SystemSettingsResponse extends SystemSettings {
  success?: boolean;
  message?: string;
}

type SystemSettingsPatch = Partial<Pick<SystemSettings, 'systemName' | 'logoDataUrl' | 'invitePromoCopy' | 'invitePosterDataUrl' | 'supportQrDataUrl' | 'groupQrDataUrl'>>;

// 基本设置（系统名称 + Logo + 邀请推广文案 + 邀请海报）：GET 公开（登录页/推广页需要），PUT 仅管理员。
// 用 react-query 全局缓存（queryKey ['system-settings']），Sidebar/LoginPage/SettingsPage 共享。
export async function getSystemSettings(): Promise<SystemSettings> {
  const { data } = await http.get<SystemSettings>('/system-settings');
  return { systemName: data.systemName, logoDataUrl: data.logoDataUrl ?? null, invitePromoCopy: data.invitePromoCopy ?? '', invitePosterDataUrl: data.invitePosterDataUrl ?? null, supportQrDataUrl: data.supportQrDataUrl ?? null, groupQrDataUrl: data.groupQrDataUrl ?? null };
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
  return { systemName: data.systemName, logoDataUrl: data.logoDataUrl ?? null, invitePromoCopy: data.invitePromoCopy ?? '', invitePosterDataUrl: data.invitePosterDataUrl ?? null, supportQrDataUrl: data.supportQrDataUrl ?? null, groupQrDataUrl: data.groupQrDataUrl ?? null };
}

export function useSaveSystemSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SystemSettingsPatch) => saveSystemSettings(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['system-settings'] });
      qc.invalidateQueries({ queryKey: ['support-config'] });
    },
  });
}
