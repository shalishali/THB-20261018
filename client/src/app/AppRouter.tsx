import { lazy, Suspense, useEffect, useState } from 'react';
import type { SectionId } from '../shared/types/navigation';
import { getAppMenuItemById } from './menuConfig';
import { canAccessSection } from '../shared/permissions';
import { useAuth } from '../shared/api/auth';
import DeveloperDemoPage, { isDeveloperDemoSection } from '../features/developer/pages/DeveloperDemoPage';
import SecondaryMenuPage from '../shared/ui/SecondaryMenuPage';

// 路由级代码分割：登录页只加载应用壳 + 登录表单，各业务页按需加载。
// 此前 25+ 页面静态引入，首屏单块 1.1MB（登录页也要下载全部业务代码）。
const DashboardPage = lazy(() => import('../features/dashboard/pages/DashboardPage'));
const ProjectSummaryPage = lazy(() => import('../features/dashboard/pages/ProjectSummaryPage'));
const UserManagementPage = lazy(() => import('../features/user-management/pages/UserManagementPage'));
const PromptManagementPage = lazy(() => import('../features/prompt-management/pages/PromptManagementPage'));
const BusinessBidPage = lazy(() => import('../features/business-bid/pages/BusinessBidPage'));
const AnalyticsPage = lazy(() => import('../features/analytics/pages/AnalyticsPage'));
const ContentExpansionReplaceTestPage = lazy(() => import('../features/developer/pages/ContentExpansionReplaceTestPage'));
const OpenCodeAgentTestPage = lazy(() => import('../features/developer/pages/OpenCodeAgentTestPage'));
const DeveloperTestPage = lazy(() => import('../features/developer/pages/DeveloperTestPage'));
const ExportFormatPage = lazy(() => import('../features/export-format/pages/ExportFormatPage'));
const MyTemplatesPage = lazy(() => import('../features/export-format/pages/MyTemplatesPage'));
const DuplicateCheckPage = lazy(() => import('../features/duplicate-check/pages/DuplicateCheckPage'));
const RejectionCheckPage = lazy(() => import('../features/rejection-check/pages/RejectionCheckPage'));
const SettingsPage = lazy(() => import('../features/settings/pages/SettingsPage'));
const DocsPage = lazy(() => import('../features/docs/pages/DocsPage'));
const FaqPage = lazy(() => import('../features/feedback/pages/FaqPage'));
const InvitePromotionPage = lazy(() => import('../features/invite/pages/InvitePromotionPage'));
const TechnicalPlanHome = lazy(() => import('../features/technical-plan/pages/TechnicalPlanHome'));

interface AppRouterProps {
  activeSection: SectionId;
  developerMode: boolean;
  onDeveloperModeChange: (developerMode: boolean) => void;
  onSectionChange: (section: SectionId) => void;
  registerLeaveGuard?: (guard: ((nextSection?: string) => Promise<boolean>) | null) => void;
}

function SectionLoading() {
  return <div style={{ padding: 24, color: '#64748b', fontSize: 13 }}>正在加载…</div>;
}

function AppRouter({ activeSection, developerMode, onDeveloperModeChange, onSectionChange, registerLeaveGuard }: AppRouterProps) {
  const { user } = useAuth();
  const activeMenuItem = getAppMenuItemById(activeSection, developerMode);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);

  useEffect(() => {
    if (activeSection !== 'my-templates') {
      setEditingTemplateId(null);
    }
  }, [activeSection]);

  // 可访问性回退：当前 section 无权访问时回到仪表盘（处理直链/权限被改后落地）。
  useEffect(() => {
    if (activeSection !== 'dashboard' && !canAccessSection(user?.role, user?.modules, activeSection)) {
      onSectionChange('dashboard');
    }
  }, [activeSection, user?.role, user?.modules, onSectionChange]);

  const renderSection = () => {
    if (activeMenuItem?.children?.length) {
      return <SecondaryMenuPage menuItem={activeMenuItem} onNavigate={onSectionChange} />;
    }

    if (isDeveloperDemoSection(activeSection)) {
      return <DeveloperDemoPage sectionId={activeSection} />;
    }

    switch (activeSection) {
      case 'dashboard':
        return <DashboardPage onSectionChange={onSectionChange} />;
      case 'project-summary':
        return <ProjectSummaryPage onSectionChange={onSectionChange} />;
      case 'user-management':
        return <UserManagementPage />;
      case 'analytics':
        return <AnalyticsPage />;
      case 'prompt-management':
        return <PromptManagementPage />;
      case 'technical-plan':
        return <TechnicalPlanHome workflowKind="technical-plan" registerLeaveGuard={registerLeaveGuard} onSectionChange={onSectionChange} />;
      case 'existing-plan-expansion':
        return <TechnicalPlanHome workflowKind="existing-plan-expansion" registerLeaveGuard={registerLeaveGuard} onSectionChange={onSectionChange} />;
      case 'business-bid':
        return <BusinessBidPage />;
      // 知识库 / 资产资质库 / 人员资质库 / 响应偏离表页面已随模块裁剪下线（canAccessSection / RETIRED_SECTIONS 会拒绝，
      // 落地时被上面的可访问性回退重定向到仪表盘）。
      case 'duplicate-check':
        return <DuplicateCheckPage />;
      case 'rejection-check':
        return <RejectionCheckPage />;
      case 'template-settings':
        // 格式管理一级入口直达"我的模板"（不再经过二级菜单页）
        return editingTemplateId
          ? <ExportFormatPage mode="edit" templateId={editingTemplateId} onBack={() => setEditingTemplateId(null)} />
          : <MyTemplatesPage onCreateTemplate={() => onSectionChange('new-template')} onEditTemplate={setEditingTemplateId} />;
      case 'my-templates':
        return editingTemplateId
          ? <ExportFormatPage mode="edit" templateId={editingTemplateId} onBack={() => setEditingTemplateId(null)} />
          : <MyTemplatesPage onCreateTemplate={() => onSectionChange('new-template')} onEditTemplate={setEditingTemplateId} />;
      case 'new-template':
        return <ExportFormatPage mode="create" />;
      case 'export-format':
        return <ExportFormatPage mode="create" />;
      case 'developer-test':
        return null;
      case 'developer-json-test':
        return <DeveloperTestPage />;
      case 'developer-expansion-replace-test':
        return <ContentExpansionReplaceTestPage />;
      case 'developer-opencode-agent-test':
        return <OpenCodeAgentTestPage />;
      case 'settings':
        return <SettingsPage onDeveloperModeChange={onDeveloperModeChange} />;
      case 'docs-usage':
        return <DocsPage key="docs-usage" section="usage" />;
      case 'docs-config':
        return <DocsPage key="docs-config" section="config" />;
      case 'faq':
        return <FaqPage />;
      case 'invite':
        return <InvitePromotionPage />;
      default:
        return null;
    }
  };

  return <Suspense fallback={<SectionLoading />}>{renderSection()}</Suspense>;
}

export default AppRouter;
