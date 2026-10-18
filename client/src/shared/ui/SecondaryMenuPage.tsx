import type { AppMenuItem, AppSubMenuItem, SectionId } from '../types/navigation';
import { useToast } from './ToastProvider';
import { useProject } from '../../app/ProjectContext';
import { useQueryClient } from '@tanstack/react-query';

interface SecondaryMenuPageProps {
  menuItem: AppMenuItem;
  onNavigate: (section: SectionId) => void;
}

function SecondaryMenuPage({ menuItem, onNavigate }: SecondaryMenuPageProps) {
  const children = menuItem.children ?? [];
  const { showToast } = useToast();
  const { projects, activeProjectId, switchTo, createAndSwitch } = useProject();
  const qc = useQueryClient();

  // 点击「生成技术方案」/「已有方案扩写」→ 直接新建独立项目并进入 STEP01
  // 每次点击都是全新项目，不关联之前的任何项目；项目名称由解析后自动回填（默认编号）
  const quickCreateAndEnter = async (workflowSection: SectionId) => {
    try {
      const created = await createAndSwitch('', '', workflowSection);
      // 标记工作流类型（技术方案/扩写），仪表盘区分类别用
      await qc.invalidateQueries({ queryKey: ['projects', 'stats'] });
      showToast(`项目 ${created.projectCode} 已创建，请上传文件`, 'success');
      onNavigate(workflowSection);
    } catch (err) {
      showToast(`创建项目失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  // 标书查重/废标项检查按项目隔离：进入前确保有活跃项目
  const guardProjectScoped = async (section: SectionId) => {
    if (activeProjectId != null) {
      onNavigate(section);
      return;
    }
    const recent = [...projects]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
    if (recent) {
      try {
        await switchTo(recent.id);
        showToast(`已切换到项目 ${recent.projectCode}`, 'info');
        onNavigate(section);
      } catch (err) {
        showToast(`切换失败：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
      return;
    }
    showToast('请先创建或选择一个项目后再进入', 'info');
  };

  const handleItemClick = (item: AppSubMenuItem) => {
    if (item.notice) {
      showToast(item.notice.message, 'info', { duration: 7000 });
      return;
    }
    if (item.id === 'technical-plan') { void quickCreateAndEnter('technical-plan'); return; }
    if (item.id === 'existing-plan-expansion') { void quickCreateAndEnter('existing-plan-expansion'); return; }
    if (item.id === 'duplicate-check' || item.id === 'rejection-check') { void guardProjectScoped(item.id); return; }
    onNavigate(item.id);
  };

  return (
    <div className="page-stack secondary-menu-page">
      <section className="panel secondary-menu-list-panel">
        <div className="secondary-menu-list-head">
          <div>
            <span>{menuItem.label}</span>
            <p>{menuItem.description}</p>
          </div>
        </div>
        {children.length ? (
          <div className="secondary-menu-list" aria-label={`${menuItem.label}二级菜单`}>
            {children.map((item) => (
              <button key={item.id} type="button" className="secondary-menu-row" onClick={() => handleItemClick(item)}>
                <span className="secondary-menu-row-icon" aria-hidden="true">
                  <SubMenuIcon item={item} />
                </span>
                <span className="secondary-menu-row-copy">
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                <span className="secondary-menu-row-arrow">
                  <ArrowIcon />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="secondary-menu-empty">
            <strong>暂无二级入口</strong>
            <span>当前一级菜单还没有配置可进入的子功能。</span>
          </div>
        )}
      </section>
    </div>
  );
}

async function openExternalUrl(url: string) {
  if (!url) return;
  if (window.yibiao?.openExternal) {
    await window.yibiao.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function SubMenuIcon({ item }: { item: AppSubMenuItem }) {
  switch (item.icon) {
    case 'document':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M7 3.8h6.6L17 7.2v13H7z" />
          <path d="M13.3 4v3.6h3.5" />
          <path d="M9.5 12h5" />
          <path d="M9.5 15.2h4" />
        </svg>
      );
    case 'expand':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5.5 6.2h8.8v5.7H5.5z" />
          <path d="M9.2 15.3h9.3" />
          <path d="M9.2 18.4h6.5" />
        </svg>
      );
    case 'briefcase':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5 8.2h14v10.3H5z" />
          <path d="M9 8.2V5.5h6v2.7" />
          <path d="M5 12.3h14" />
          <path d="M10.5 12.3v1.8h3v-1.8" />
        </svg>
      );
    case 'compare':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M7 5.8h7.5" />
          <path d="M7 9.1h5.4" />
          <path d="M5.5 15.3h7.5" />
          <path d="M5.5 18.6h5.4" />
          <path d="m16.5 13.6 2 2 2-2" />
          <path d="M18.5 15.6V5.2" />
          <path d="m7.5 8.7-2-2 2-2" />
          <path d="M5.5 6.7v10.5" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M6 5.5h12v13H6z" />
          <path d="M9 9h6" />
          <path d="M9 12h6" />
          <path d="M9 15h4" />
        </svg>
      );
  }
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M5 12h13" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

export default SecondaryMenuPage;
