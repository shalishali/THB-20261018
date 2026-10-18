import * as Dialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useState, type ComponentType, type ReactElement, type SVGProps } from 'react';
import { getAppMenuItems, getParentMenuItemBySection } from '../app/menuConfig';
import type { AppMenuItem, SectionId } from '../shared/types/navigation';
import { useAuth } from '../shared/api/auth';
import { useToast } from '../shared/ui';

interface SidebarProps {
  activeSection: SectionId;
  developerMode: boolean;
  onSectionChange: (section: SectionId) => void;
}

const navigationIcons: Record<SectionId, ComponentType<SVGProps<SVGSVGElement>>> = {
  dashboard: DashboardIcon,
  'project-summary': DashboardIcon,
  'bid-generation': BidGenerationIcon,
  'technical-plan': DocumentIcon,
  'existing-plan-expansion': DocumentIcon,
  'business-bid': BriefcaseIcon,
  'response-deviation-table': CompareIcon,
  'knowledge-base': ArchiveIcon,
  'document-knowledge-base': ArchiveIcon,
  'tool-asset-library': ArchiveIcon,
  'company-qualification-library': ShieldIcon,
  'personnel-qualification-library': BriefcaseIcon,
  'bid-check': BidCheckIcon,
  'duplicate-check': CompareIcon,
  'rejection-check': ShieldIcon,
  'template-settings': DocumentIcon,
  'my-templates': DocumentIcon,
  'new-template': DocumentIcon,
  'export-format': DocumentIcon,
  'developer-test': FlaskIcon,
  'developer-json-test': FlaskIcon,
  'developer-prompt-lab': FlaskIcon,
  'developer-parser-sandbox': FlaskIcon,
  'developer-export-preview': FlaskIcon,
  'developer-expansion-replace-test': FlaskIcon,
  'developer-opencode-agent-test': FlaskIcon,
  settings: GearIcon,
  docs: BookIcon,
  'docs-usage': DocumentIcon,
  'docs-config': DocumentIcon,
  faq: ChatBubbleIcon,
  invite: UserIcon,
  'user-management': UserIcon,
  'prompt-management': PromptIcon,
  analytics: ChartIcon,
};

function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 20h16" />
      <path d="M7 16v-5M12 16V7M17 16v-8" />
    </svg>
  );
}

function Sidebar({ activeSection, developerMode, onSectionChange }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { showToast } = useToast();
  const { user } = useAuth();
  const menuItems = getAppMenuItems(developerMode, user?.role, user?.modules);
  const activeParent = getParentMenuItemBySection(activeSection, developerMode);

  const handleMenuItemClick = (item: AppMenuItem) => {
    if (!item.notice) {
      onSectionChange(item.id);
      return;
    }

    showToast(item.notice.message, 'info', {
      duration: 7000,
      actions: item.notice.externalUrl ? [
        {
          label: item.notice.actionLabel || '打开链接',
          variant: 'primary',
          onClick: () => openExternalUrl(item.notice?.externalUrl || ''),
        },
      ] : undefined,
    });
  };

  return (
    <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="sidebar-surface" />

      <button
        type="button"
        className="collapse-button"
        onClick={() => setCollapsed((value) => !value)}
        aria-label={collapsed ? '展开菜单' : '收起菜单'}
      >
        <ChevronIcon className={collapsed ? 'rotate-180' : ''} />
      </button>

      <nav className="sidebar-nav" aria-label="主菜单">
        {menuItems.map((item) => {
          const Icon = navigationIcons[item.id];
          const isActive = item.id === activeSection || activeParent?.id === item.id;
          const button = (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${isActive ? 'is-active' : ''}`}
              onClick={() => handleMenuItemClick(item)}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
            >
              <span className="nav-icon" aria-hidden="true">
                <Icon />
              </span>
              <span className="nav-copy">
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          );

          return collapsed ? wrapTooltip(item.label, button) : button;
        })}
      </nav>

      <div className="sidebar-footer">
        {collapsed ? wrapTooltip('加群', <JoinGroupButton key="join" />) : <JoinGroupButton />}
        {collapsed ? wrapTooltip('客服', <CustomerServiceButton key="cs" />) : <CustomerServiceButton />}
        {/* 设置入口仅管理员可见（普通用户的模型配置/基本设置均为管理员专属） */}
        {user?.role === 'admin' && (
          (collapsed ? wrapTooltip('设置', renderSettingsButton(activeSection, onSectionChange)) : renderSettingsButton(activeSection, onSectionChange))
        )}
      </div>
    </aside>
  );
}

// 客服入口：展示企业微信群二维码 + 联系电话。
const CUSTOMER_SERVICE_PHONE = '17341418824';
const CUSTOMER_SERVICE_QR = '/support-group-qr.png';

function CustomerServiceButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="settings-trigger customer-service-trigger"
        onClick={() => setOpen(true)}
        aria-label="客服"
      >
        <span className="nav-icon" aria-hidden="true">
          <HeadsetIcon />
        </span>
        <span className="settings-copy">
          <strong>客服</strong>
          <small>咨询与技术支持</small>
        </span>
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="quota-dialog-overlay" />
          <Dialog.Content className="quota-dialog customer-service-dialog" aria-describedby={undefined}>
            <div className="quota-dialog-head">
              <Dialog.Title>联系客服</Dialog.Title>
              <Dialog.Close className="quota-dialog-close" aria-label="关闭">×</Dialog.Close>
            </div>
            <div className="customer-service-qr">
              <img
                src={CUSTOMER_SERVICE_QR}
                alt="客服二维码"
                onError={(event) => {
                  (event.currentTarget as HTMLImageElement).style.display = 'none';
                  const next = event.currentTarget.nextElementSibling as HTMLElement | null;
                  if (next) next.style.display = 'grid';
                }}
              />
              <div className="customer-service-qr-placeholder">企业微信二维码<br />即将上线</div>
            </div>
            <div className="customer-service-phone">
              <small>客服电话</small>
              <strong>
                <a href={`tel:${CUSTOMER_SERVICE_PHONE}`}>{CUSTOMER_SERVICE_PHONE}</a>
              </strong>
            </div>
            <p className="customer-service-text">期待您的咨询，我们将尽快为您解答！</p>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function HeadsetIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 13v-2a8 8 0 0 1 16 0v2" />
      <rect x="2.5" y="13" width="4" height="6" rx="1.5" />
      <rect x="17.5" y="13" width="4" height="6" rx="1.5" />
      <path d="M19.5 19v1a2 2 0 0 1-2 2H13" />
    </svg>
  );
}

// 加群入口：展示企业微信/交流群二维码（后期把 support-group-qr.png 放入 client/public/ 即生效）。
function JoinGroupButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="settings-trigger join-group-trigger"
        onClick={() => setOpen(true)}
        aria-label="加群"
      >
        <span className="nav-icon" aria-hidden="true">
          <GroupIcon />
        </span>
        <span className="settings-copy">
          <strong>加群</strong>
          <small>交流与技术支持</small>
        </span>
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="quota-dialog-overlay" />
          <Dialog.Content className="quota-dialog join-group-dialog" aria-describedby={undefined}>
            <div className="quota-dialog-head">
              <Dialog.Title>加入交流群</Dialog.Title>
              <Dialog.Close className="quota-dialog-close" aria-label="关闭">×</Dialog.Close>
            </div>
            <div className="join-group-qr">
              <img
                src="support-group-qr.png"
                alt="企业微信交流群二维码"
                onError={(event) => {
                  (event.currentTarget as HTMLImageElement).style.display = 'none';
                  const next = event.currentTarget.nextElementSibling as HTMLElement | null;
                  if (next) next.style.display = 'grid';
                }}
              />
              <div className="join-group-placeholder">企业微信群二维码即将上线<br />敬请关注</div>
            </div>
            <p className="join-group-note">扫码加入交流群，获取技术支持与产品动态。</p>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function GroupIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19c.6-3 2.8-4.7 5.5-4.7s4.9 1.7 5.5 4.7" />
      <circle cx="17" cy="9.5" r="2.4" />
      <path d="M15.6 14.6c2.3.2 4.2 1.7 4.9 4.4" />
    </svg>
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

function renderSettingsButton(activeSection: SectionId, onSectionChange: (section: SectionId) => void) {
  const isActive = activeSection === 'settings';

  return (
    <button
      type="button"
      className={`settings-trigger ${isActive ? 'is-active' : ''}`}
      onClick={() => onSectionChange('settings')}
      aria-current={isActive ? 'page' : undefined}
      aria-label="设置"
    >
      <span className="nav-icon" aria-hidden="true">
        <GearIcon />
      </span>
      <span className="settings-copy">
        <strong>设置</strong>
        <small>模型与解析配置</small>
      </span>
    </button>
  );
}

function wrapTooltip(label: string, child: ReactElement) {
  return (
    <Tooltip.Root key={label}>
      <Tooltip.Trigger asChild>{child}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" side="right" align="center" sideOffset={12}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function BidGenerationIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M6 5.2h7.2l4.8 4.8v8.8H6z" />
      <path d="M13 5.5V10h4.5" />
      <path d="M8.8 13.2h6.4" />
      <path d="M8.8 16.3h4.5" />
      <path d="M4.5 7.2v13h12" />
    </svg>
  );
}

function DocumentIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M7 3.75h6.7L18 8.05v12.2H7z" />
      <path d="M13.5 4v4.35h4.25" />
      <path d="M9.5 12.2h5" />
      <path d="M9.5 15.7h4" />
    </svg>
  );
}

function BriefcaseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M5 8h14v11.5H5z" />
      <path d="M9 8V5.5h6V8" />
      <path d="M5 12.5h14" />
      <path d="M10.5 12.5v2h3v-2" />
    </svg>
  );
}

function ArchiveIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M5 7.5h14v12H5z" />
      <path d="M4 4.5h16v3H4z" />
      <path d="M9 11.2h6" />
    </svg>
  );
}

function BidCheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M7 4.2h10v15.6H7z" />
      <path d="M9.5 8h5" />
      <path d="m9.5 12.3 1.5 1.5 3.7-4" />
      <path d="M9.5 17h5" />
      <path d="M5 6.2v15h10" />
    </svg>
  );
}

function CompareIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M7 5.5h7.5" />
      <path d="M7 9h5.5" />
      <path d="M5 15.5h7.5" />
      <path d="M5 19h5.5" />
      <path d="M16.5 13.5l2 2 2-2" />
      <path d="M18.5 15.5V5" />
      <path d="M7.5 8.5l-2-2 2-2" />
      <path d="M5.5 6.5V17" />
    </svg>
  );
}

function ShieldIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M12 3.5 18.5 6v5.4c0 4.25-2.55 7.55-6.5 9.1-3.95-1.55-6.5-4.85-6.5-9.1V6z" />
      <path d="m9 12.2 2 2 4-4.5" />
    </svg>
  );
}

function FlaskIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M9 3.8h6" />
      <path d="M10.5 3.8v5.4l-4.2 7.4c-.85 1.5.24 3.4 1.96 3.4h7.48c1.72 0 2.81-1.9 1.96-3.4l-4.2-7.4V3.8" />
      <path d="M8.5 15.8h7" />
      <path d="M10 12.5h4" />
    </svg>
  );
}

function GearIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" />
      <path d="m19.1 13.5.1-1.5-.1-1.5 2-1.5-2-3.4-2.45.95a8.2 8.2 0 0 0-2.55-1.45L13.75 2h-3.5L9.9 5.1a8.2 8.2 0 0 0-2.55 1.45L4.9 5.6l-2 3.4 2 1.5L4.8 12l.1 1.5-2 1.5 2 3.4 2.45-.95A8.2 8.2 0 0 0 9.9 18.9l.35 3.1h3.5l.35-3.1a8.2 8.2 0 0 0 2.55-1.45l2.45.95 2-3.4z" />
    </svg>
  );
}

function DashboardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M4 5.5h6.5v6.5H4z" />
      <path d="M13.5 5.5H20v4h-6.5z" />
      <path d="M13.5 12H20v6.5h-6.5z" />
      <path d="M4 14.5h6.5V19H4z" />
    </svg>
  );
}

function UserIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <circle cx="12" cy="8.2" r="3.6" />
      <path d="M4.8 20c.9-3.6 3.7-5.6 7.2-5.6s6.3 2 7.2 5.6" />
    </svg>
  );
}

function PromptIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M4.5 6.5h15v8h-9L7 18v-3.5H4.5z" />
      <path d="M8 10h8" />
      <path d="M8 12.5h5" />
    </svg>
  );
}

function BookIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M5.5 4.5h5.2c1.25 0 2.3 1.05 2.3 2.3v12.7c-.45-.8-1.25-1.3-2.3-1.3H5.5z" />
      <path d="M18.5 4.5h-5.2C12.05 4.5 11 5.55 11 6.8v12.7c.45-.8 1.25-1.3 2.3-1.3h5.2z" />
      <path d="M8 8h2" />
      <path d="M14 8h2" />
    </svg>
  );
}

function ChatBubbleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M4 5.5h16v10H8.5L5 19v-3.5H4z" />
      <path d="M8 9h8" />
      <path d="M8 12h5" />
    </svg>
  );
}

function ChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <path d="m14 7-5 5 5 5" />
    </svg>
  );
}

export default Sidebar;
