import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { renderMarkdownHtml } from '../markdown/renderMarkdownHtml';
import { useTheme } from '../theme/ThemeProvider';
import type { ThemeMode } from '../theme/theme';

type MarkdownImageMode = 'default' | 'preview' | 'lazy';
type MarkdownLinkMode = 'default' | 'external' | 'text';

interface MarkdownRendererProps {
  children: string;
  allowRawHtml?: boolean;
  enableGfm?: boolean;
  imageMode?: MarkdownImageMode;
  imageClassName?: string;
  linkMode?: MarkdownLinkMode;
  linkTextClassName?: string;
  renderMermaid?: boolean;
  previewImageTitle?: string;
  onPreviewImage?: (src: string, alt: string) => void;
}

function normalizeExternalUrl(value: string | undefined) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return /^www\./i.test(raw) ? `https://${raw}` : raw;
}

function isExternalHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

// 原始 HTML 不经过 markdown-it 的 validateLink：`<a href="javascript:...">` 会原样渲染成
// 可点击链接，构成存储型 XSS（本项目 token 存 localStorage，中招即完整账号接管）。
// 这里对 href / img src 做协议白名单，作为 allowRawHtml 场景的最后一道闸。
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:', 'blob:']);

// 判协议前先去掉空白与控制字符：浏览器会忽略 `java\tscript:` 中间的这类字符。
function compactUrl(value: string): string {
  return String(value || '').replace(/[\u0000-\u0020\u007F]/g, '');
}

function urlProtocol(value: string): string | null {
  const matched = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  return matched ? `${matched[1].toLowerCase()}:` : null;
}

/** 链接地址是否可安全放进 <a href>：相对路径/锚点放行，显式协议仅放行白名单。 */
export function isSafeLinkUrl(value: string): boolean {
  const compact = compactUrl(value);
  if (!compact) return true;
  // 协议相对 URL（//evil.com）与反斜杠变体（浏览器把 \ 归一为 /）不带协议，
  // 但点击会离开本站；按不可信处理，降级为纯文本（避免同标签页被带走）。
  if (/^[\\/]{2}/.test(compact)) return false;
  const protocol = urlProtocol(compact);
  if (!protocol) return true;
  return SAFE_LINK_PROTOCOLS.has(protocol);
}

/** 图片地址是否可安全放进 <img src>：data: 仅允许 data:image/*。 */
export function isSafeImageUrl(value: string): boolean {
  const compact = compactUrl(value);
  if (!compact) return false;
  const protocol = urlProtocol(compact);
  if (!protocol) return true;
  if (protocol === 'data:') return /^data:image\//i.test(compact);
  return SAFE_IMAGE_PROTOCOLS.has(protocol);
}

function openExternal(url: string) {
  if (window.yibiao?.openExternal) {
    void window.yibiao.openExternal(url);
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}

// 判断 Mermaid 代码是否属于当前支持的 flowchart 语法。
function isSupportedMermaidSyntax(code: string) {
  return /^flowchart\s+(?:TD|TB|LR|RL|BT)\b/i.test(String(code || '').trim());
}

function MermaidPreview({ code, theme }: { code: string; theme: ThemeMode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    const trimmedCode = String(code || '').trim();

    if (!trimmedCode) {
      setStatus('error');
      setErrorMessage('Mermaid 图代码为空');
      if (container) container.innerHTML = '';
      return undefined;
    }
    if (!isSupportedMermaidSyntax(trimmedCode)) {
      setStatus('error');
      setErrorMessage('仅支持流程图、层级图和职责关系图，且必须使用 flowchart TD/TB/LR/RL/BT 语法');
      if (container) container.innerHTML = '';
      return undefined;
    }

    setStatus('loading');
    setErrorMessage('');
    if (container) container.innerHTML = '';

    import('mermaid')
      .then((module) => {
        const mermaid = module.default;
        mermaid.initialize({
          startOnLoad: false,
          theme: theme === 'soc-dark' ? 'dark' : 'default',
          securityLevel: 'strict',
        });
        return mermaid.render(`mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`, trimmedCode);
      })
      .then(({ svg }) => {
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = svg;
        setStatus('success');
      })
      .catch((error) => {
        if (cancelled) return;
        setStatus('error');
        setErrorMessage(error instanceof Error ? error.message : 'Mermaid 图渲染失败');
      });

    return () => {
      cancelled = true;
      if (container) container.innerHTML = '';
    };
  }, [code, theme]);

  return (
    <figure className={`mermaid-preview-card is-${status}`}>
      {status === 'loading' && <span>正在渲染 Mermaid 图...</span>}
      {status === 'error' && (
        <div className="mermaid-preview-error">
          <strong>Mermaid 图渲染失败</strong>
          <small>{errorMessage}</small>
          <pre>{code}</pre>
        </div>
      )}
      <div ref={containerRef} className="mermaid-preview-canvas" aria-hidden={status !== 'success'} />
    </figure>
  );
}

function getElementClassName(element: Element) {
  return element.getAttribute('class') || undefined;
}

function getPositiveSpan(element: Element, attributeName: 'colspan' | 'rowspan') {
  const parsed = Number.parseInt(element.getAttribute(attributeName) || '', 10);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : undefined;
}

function childrenFromDom(nodes: ChildNode[], renderNode: (node: ChildNode, index: number) => ReactNode) {
  return nodes.map((node, index) => renderNode(node, index));
}

function MarkdownRenderer({
  children,
  // 默认仍渲染原始 HTML：解析/生成链路会把表格以 `<table>`、换行以 `<br>` 保留下来
  // （见 document/doc2markdown/convert.mjs、tasks/utils/mirrorProcurement.ts），
  // 关掉会让正文表格退化成字面标签。安全由下方「标签白名单 + href/src 协议白名单」保证：
  // script/iframe/style/事件属性都不会被映射到 DOM，javascript: 链接会被降级为纯文本。
  allowRawHtml = true,
  enableGfm = true,
  imageMode = 'default',
  imageClassName,
  linkMode = 'external',
  linkTextClassName,
  renderMermaid = false,
  previewImageTitle = '点击放大查看',
  onPreviewImage,
}: MarkdownRendererProps) {
  const { theme } = useTheme();
  const html = useMemo(() => renderMarkdownHtml(children, { allowRawHtml, enableGfm }), [allowRawHtml, children, enableGfm]);

  const content = useMemo(() => {
    const document = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const root = document.body.firstElementChild;
    const renderNode = (node: ChildNode, index: number): ReactNode => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return null;

      const element = node as Element;
      const tag = element.tagName.toLowerCase();
      const childNodes = Array.from(element.childNodes);
      const renderedChildren = childrenFromDom(childNodes, renderNode);
      const className = getElementClassName(element);
      const key = `${tag}-${index}`;

      if (tag === 'br') return <br key={key} />;
      if (tag === 'hr') return <hr key={key} />;
      if (tag === 'a') {
        const href = element.getAttribute('href') || '';
        const externalUrl = normalizeExternalUrl(href);
        if (linkMode === 'text') {
          return <span key={key} className={linkTextClassName}>{renderedChildren}</span>;
        }
        // 不安全协议（javascript:/data:/vbscript:…）降级为纯文本，不生成可点击链接。
        if (!isSafeLinkUrl(href)) {
          return <span key={key} className={className}>{renderedChildren}</span>;
        }

        const isExternal = linkMode === 'external' && isExternalHttpUrl(externalUrl);
        return (
          <a
            key={key}
            className={className}
            href={isExternal ? externalUrl : href}
            rel={isExternal ? 'noreferrer' : undefined}
            target={isExternal ? '_blank' : undefined}
            onClick={(event) => {
              if (!isExternal) return;
              event.preventDefault();
              event.stopPropagation();
              openExternal(externalUrl);
            }}
          >
            {renderedChildren}
          </a>
        );
      }

      if (tag === 'img') {
        const src = element.getAttribute('src') || '';
        const alt = element.getAttribute('alt') || '正文图片';
        // 非图片协议（javascript:/data:text/html 等）不生成 <img>，只保留替代文字。
        if (!isSafeImageUrl(src)) {
          return <span key={key}>{alt}</span>;
        }
        const previewEnabled = imageMode === 'preview' && Boolean(src) && Boolean(onPreviewImage);
        const handlePreview = () => {
          if (previewEnabled) onPreviewImage?.(src, alt);
        };
        const handleKeyDown = (event: KeyboardEvent<HTMLImageElement>) => {
          if (!previewEnabled || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          handlePreview();
        };

        return (
          <img
            key={key}
            src={src}
            alt={alt}
            className={imageClassName || className}
            loading={imageMode === 'lazy' ? 'lazy' : undefined}
            decoding={imageMode === 'lazy' ? 'async' : undefined}
            role={previewEnabled ? 'button' : undefined}
            tabIndex={previewEnabled ? 0 : undefined}
            title={previewEnabled ? previewImageTitle : undefined}
            onClick={previewEnabled ? handlePreview : undefined}
            onKeyDown={previewEnabled ? handleKeyDown : undefined}
          />
        );
      }

      if (tag === 'pre' && renderMermaid) {
        const code = element.querySelector('code');
        if (code && /\blanguage-mermaid\b/i.test(code.getAttribute('class') || '')) {
          return <MermaidPreview key={key} code={(code.textContent || '').replace(/\n$/, '')} theme={theme} />;
        }
      }

      if (tag === 'input' && (element.getAttribute('type') || '').toLowerCase() === 'checkbox') {
        return (
          <input
            key={key}
            id={element.getAttribute('id') || undefined}
            type="checkbox"
            checked={element.hasAttribute('checked')}
            disabled
            readOnly
            className={className}
          />
        );
      }

      const props = { key, className };
      if (tag === 'p') {
        const isFigureCaption = /^图[:：]/.test((element.textContent || '').trim());
        return <p {...props} className={[className, isFigureCaption ? 'markdown-figure-caption' : ''].filter(Boolean).join(' ') || undefined}>{renderedChildren}</p>;
      }

      if (tag === 'h1') return <h1 {...props}>{renderedChildren}</h1>;
      if (tag === 'h2') return <h2 {...props}>{renderedChildren}</h2>;
      if (tag === 'h3') return <h3 {...props}>{renderedChildren}</h3>;
      if (tag === 'h4') return <h4 {...props}>{renderedChildren}</h4>;
      if (tag === 'h5') return <h5 {...props}>{renderedChildren}</h5>;
      if (tag === 'h6') return <h6 {...props}>{renderedChildren}</h6>;
      if (tag === 'strong') return <strong {...props}>{renderedChildren}</strong>;
      if (tag === 'b') return <b {...props}>{renderedChildren}</b>;
      if (tag === 'em') return <em {...props}>{renderedChildren}</em>;
      if (tag === 'i') return <i {...props}>{renderedChildren}</i>;
      if (tag === 'del') return <del {...props}>{renderedChildren}</del>;
      if (tag === 's') return <s {...props}>{renderedChildren}</s>;
      if (tag === 'ul') return <ul {...props}>{renderedChildren}</ul>;
      if (tag === 'ol') return <ol {...props}>{renderedChildren}</ol>;
      if (tag === 'li') return <li {...props}>{renderedChildren}</li>;
      if (tag === 'table') {
        return (
          <div key={key} className="markdown-table-scroll">
            <table className={className}>{renderedChildren}</table>
          </div>
        );
      }
      if (tag === 'thead') return <thead {...props}>{renderedChildren}</thead>;
      if (tag === 'tbody') return <tbody {...props}>{renderedChildren}</tbody>;
      if (tag === 'tr') return <tr {...props}>{renderedChildren}</tr>;
      if (tag === 'th') return <th {...props} colSpan={getPositiveSpan(element, 'colspan')} rowSpan={getPositiveSpan(element, 'rowspan')}>{renderedChildren}</th>;
      if (tag === 'td') return <td {...props} colSpan={getPositiveSpan(element, 'colspan')} rowSpan={getPositiveSpan(element, 'rowspan')}>{renderedChildren}</td>;
      if (tag === 'blockquote') return <blockquote {...props}>{renderedChildren}</blockquote>;
      if (tag === 'pre') return <pre {...props}>{renderedChildren}</pre>;
      if (tag === 'code') return <code {...props}>{renderedChildren}</code>;
      if (tag === 'mark') return <mark {...props}>{renderedChildren}</mark>;
      if (tag === 'small') return <small {...props}>{renderedChildren}</small>;
      if (tag === 'sub') return <sub {...props}>{renderedChildren}</sub>;
      if (tag === 'sup') return <sup {...props}>{renderedChildren}</sup>;
      if (tag === 'label') return <label {...props} htmlFor={element.getAttribute('for') || undefined}>{renderedChildren}</label>;
      if (tag === 'span') return <span {...props}>{renderedChildren}</span>;
      if (tag === 'div') return <div {...props}>{renderedChildren}</div>;
      if (tag === 'section') return <section {...props}>{renderedChildren}</section>;
      if (tag === 'article') return <article {...props}>{renderedChildren}</article>;

      return <span key={key}>{renderedChildren}</span>;
    };

    return Array.from(root?.childNodes || []).map((node, index) => renderNode(node, index));
  }, [enableGfm, html, imageClassName, imageMode, linkMode, linkTextClassName, onPreviewImage, previewImageTitle, renderMermaid, theme]);

  return <>{content}</>;
}

export default MarkdownRenderer;
