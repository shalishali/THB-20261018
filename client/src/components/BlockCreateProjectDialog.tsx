// 第5点（2026-10-19 修正）：只有「正在生成方案」时才禁止新建项目；未完成但空闲的项目不拦。
// 本弹窗在用户点「新建项目/上传招标文件」且命中生成中项目、或后端 POST /projects 返回 409 时弹出。
// 三动作：继续该项目（切回并进入流程）/ 删除该项目 / 取消。管理员豁免（不在调用方触发）。
import * as Dialog from '@radix-ui/react-dialog';
import type { Project } from '../shared/api/projects';

interface BlockCreateProjectDialogProps {
  open: boolean;
  conflictingProject: Project | null;
  busy?: boolean;
  onContinue: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

function BlockCreateProjectDialog({ open, conflictingProject, busy, onContinue, onDelete, onCancel }: BlockCreateProjectDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="create-project-dialog">
          <Dialog.Title>项目正在生成方案</Dialog.Title>
          <Dialog.Description>
            你的项目「{conflictingProject?.name ?? ''}」（编号 {conflictingProject?.projectCode ?? ''}）正在生成方案，需要等待完成或删除后才能新建项目。
          </Dialog.Description>
          <div className="dashboard-dialog-actions">
            <button type="button" className="secondary-action" onClick={onCancel} disabled={busy}>取消</button>
            <button type="button" className="danger-action" onClick={onDelete} disabled={busy}>
              {busy ? '删除中…' : '删除该项目'}
            </button>
            <button type="button" className="primary-action" onClick={onContinue} disabled={busy}>继续该项目</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default BlockCreateProjectDialog;
