import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_INITIAL_ADMIN_PASSWORD,
  DEFAULT_INITIAL_ADMIN_USERNAME,
} from '../auth/initialPassword';

// H2 加固：初始管理员密码来源优先级——
//   1. env ADMIN_INITIAL_PASSWORD（部署方显式注入）；
//   2. 显式 development/test：保留 admin/admin（仅本地/CI）；
//   3. 其他情况（含 NODE_ENV 缺失/拼写错误/production）：随机生成 18 位密码并只打印一次。
function resolveInitialAdminPassword(): string {
  const fromEnv = process.env.ADMIN_INITIAL_PASSWORD?.trim() || '';
  if (fromEnv) return fromEnv;
  const nodeEnv = (process.env.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return DEFAULT_INITIAL_ADMIN_PASSWORD;
  }
  return randomBytes(18).toString('base64url');
}

interface InitialAdminTransaction {
  $executeRawUnsafe(sql: string): Promise<unknown>;
  user: {
    count(): Promise<number>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

interface InitialAdminDb {
  $transaction<T>(
    run: (tx: InitialAdminTransaction) => Promise<T>,
    options: { isolationLevel: 'Serializable' },
  ): Promise<T>;
}

interface PrismaLikeError {
  code?: unknown;
  meta?: { code?: unknown };
}

const USERS_TABLE_LOCK = 'LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE';
const MAX_TRANSACTION_ATTEMPTS = 3;

function prismaErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { code } = error as PrismaLikeError;
  return typeof code === 'string' ? code : undefined;
}

function isRetryableTransactionError(error: unknown): boolean {
  const code = prismaErrorCode(error);
  if (code === 'P2034' || code === '40001' || code === '40P01') return true;
  if (code !== 'P2010') return false;
  const metaCode = (error as PrismaLikeError).meta?.code;
  return metaCode === '40001' || metaCode === '40P01';
}

export async function seedInitialAdmin(db: InitialAdminDb): Promise<'created' | 'skipped'> {
  const initialPassword = resolveInitialAdminPassword();
  const password = await bcrypt.hash(initialPassword, 10);
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(USERS_TABLE_LOCK);
        if (await tx.user.count() > 0) return 'skipped';

        await tx.user.create({
          data: {
            username: DEFAULT_INITIAL_ADMIN_USERNAME,
            password,
            displayName: '管理员',
            role: 'admin',
            mustChangePassword: true,
          },
        });
        // 随机密码只在创建时打印这一次（mustChangePassword 闭环保证首登后强制更换）
        console.log('============================================================');
        console.log(`[seed] 初始管理员已创建：用户名 ${DEFAULT_INITIAL_ADMIN_USERNAME}`);
        console.log(`[seed] 初始密码：${initialPassword}`);
        console.log('[seed] 请立即保存，并按提示在首次登录时完成强制改密。');
        console.log('============================================================');
        return 'created';
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') return 'skipped';
      if (attempt < MAX_TRANSACTION_ATTEMPTS && isRetryableTransactionError(error)) continue;
      throw error;
    }
  }
  throw new Error('unreachable initial administrator seed state');
}
