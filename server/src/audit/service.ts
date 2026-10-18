// 管理员操作日志：记录管理员手动调整用户信息的行为（额度调整/账号编辑/删除等）。
// 写入 best-effort：日志失败仅打点告警，不阻断主操作。
import type { PrismaClient } from '@prisma/client';

export type AdminAuditAction = 'quota.adjust' | 'quota.order.paid' | 'user.update' | 'user.delete';

export async function writeAdminAudit(
  prisma: PrismaClient,
  adminId: number,
  targetUserId: number | null,
  action: AdminAuditAction,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        adminId,
        targetUserId,
        action,
        detail: (detail ?? undefined) as any,
      },
    });
  } catch (error) {
    console.error('[audit] 操作日志写入失败:', error instanceof Error ? error.message : error);
  }
}

export async function listAdminAuditLogs(prisma: PrismaClient, targetUserId: number, limit = 50): Promise<Record<string, unknown>[]> {
  const rows = await prisma.adminAuditLog.findMany({
    where: { targetUserId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
    include: { admin: { select: { username: true, displayName: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    detail: row.detail,
    adminUsername: row.admin?.displayName || row.admin?.username || `#${row.adminId}`,
    createdAt: row.createdAt,
  }));
}
