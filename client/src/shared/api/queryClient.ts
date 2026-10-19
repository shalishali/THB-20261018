import { QueryClient } from '@tanstack/react-query';

// 全局单例：登出时必须 clear()，否则同标签页换号会先命中上一账号的缓存
// （项目列表/配置），ProjectContext 会据此锁定错误的 activeProjectId。
export const queryClient = new QueryClient();
