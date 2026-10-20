import { useQuery } from '@tanstack/react-query';
import { http } from './http';

// 侧栏「客服 / 加群」二维码：管理员可在设置-基本设置上传，登录后所有用户共享。
export interface SupportConfig {
  supportQrDataUrl: string | null;
  groupQrDataUrl: string | null;
}

export async function getSupportConfig(): Promise<SupportConfig> {
  const { data } = await http.get<SupportConfig>('/support-config');
  return {
    supportQrDataUrl: data.supportQrDataUrl ?? null,
    groupQrDataUrl: data.groupQrDataUrl ?? null,
  };
}

export function useSupportConfig() {
  return useQuery({
    queryKey: ['support-config'],
    queryFn: getSupportConfig,
    staleTime: 5 * 60 * 1000,
  });
}
