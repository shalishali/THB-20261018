// 公开帮助中心：未登录也能阅读，替代原先直接打开 .md 文件的方式。
// 页面只依赖静态文档（client/public/docs）和公开系统设置，不请求任何业务数据。
import { useEffect, useMemo, useRef, useState } from 'react';
import logoUrl from '../../../../assets/icon_256.png';
import { useSystemSettings } from '../../../shared/api/system-settings';
import { applyFavicon } from '../../../shared/ui/favicon';
import MarkdownRenderer from '../../../shared/ui/MarkdownRenderer';
import {
  HELP_CATEGORIES,
  HELP_DOCS,
  estimateReadMinutes,
  getCategory,
  getHelpDoc,
  type HelpDoc,
} from '../helpDocs';

type LoadState = 'loading' | 'ready' | 'error';

interface HeadingItem {
  level: 2 | 3;
  text: string;
}

function getInitialDocId(): string {
  const requested = new URLSearchParams(window.location.search).get('doc');
  return getHelpDoc(requested)?.id ?? HELP_DOCS[0].id;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 文档标题已经在页面头部渲染，正文再渲染一次 H1 会重复，去掉首个标题行。 */
function stripLeadingTitle(markdown: string): string {
  return markdown.replace(/^\s*#\s+.+(?:\r?\n)+/, '');
}

function extractHeadings(markdown: string): HeadingItem[] {
  const headings: HeadingItem[] = [];
  for (const match of markdown.matchAll(/^(#{2,3})\s+(.+?)\s*$/gm)) {
    const level = match[1].length === 2 ? 2 : 3;
    const text = stripMarkdown(match[2]);
    if (text) headings.push({ level, text });
  }
  return headings;
}

function searchSnippet(doc: HelpDoc, query: string, content: string | undefined): string {
  const plain = stripMarkdown(content || '');
  const index = plain.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return doc.description;
  const start = Math.max(0, index - 34);
  const end = Math.min(plain.length, index + query.length + 58);
  return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`;
}

function setMeta(selector: string, content: string) {
  const element = document.head.querySelector<HTMLMetaElement>(selector);
  if (element) element.content = content;
}

export default function HelpCenterPage() {
  const { data: settings } = useSystemSettings();
  const systemName = settings?.systemName || '投好标';
  const logoSrc = settings?.logoDataUrl || logoUrl;

  const [selectedId, setSelectedId] = useState(getInitialDocId);
  const [query, setQuery] = useState('');
  const [contents, setContents] = useState<Record<string, string>>({});
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [reloadToken, setReloadToken] = useState(0);
  const [searchFocused, setSearchFocused] = useState(false);
  const articleBodyRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const selectedDoc = getHelpDoc(selectedId) ?? HELP_DOCS[0];
  const selectedCategory = getCategory(selectedDoc.category);
  const selectedContent = contents[selectedDoc.id];
  const renderedContent = selectedContent ? stripLeadingTitle(selectedContent) : '';
  const selectedIndex = HELP_DOCS.findIndex((doc) => doc.id === selectedDoc.id);
  const previousDoc = selectedIndex > 0 ? HELP_DOCS[selectedIndex - 1] : null;
  const nextDoc = selectedIndex >= 0 && selectedIndex < HELP_DOCS.length - 1 ? HELP_DOCS[selectedIndex + 1] : null;

  useEffect(() => {
    applyFavicon(logoSrc);
  }, [logoSrc]);

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    Promise.all(
      HELP_DOCS.map(async (doc) => {
        const response = await fetch(encodeURI(`/docs/${doc.file}`));
        if (!response.ok) throw new Error(`${doc.title} 加载失败`);
        return [doc.id, await response.text()] as const;
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        setContents(Object.fromEntries(entries));
        setLoadState('ready');
      })
      .catch(() => {
        if (!cancelled) setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  useEffect(() => {
    const onPopState = () => {
      setSelectedId(getInitialDocId());
      setQuery('');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const title = selectedContent ? `${selectedDoc.title} · ${systemName}帮助中心` : `${systemName}帮助中心`;
    const description = selectedContent
      ? `${selectedDoc.title}：${selectedDoc.description}`
      : `投好标帮助中心，包含生成技术方案、已有方案扩写、标书查重、废标项检查、模型配置等使用指南。`;
    document.title = title;
    setMeta('meta[name="description"]', description);
    setMeta('meta[property="og:title"]', title);
    setMeta('meta[property="og:description"]', description);
    setMeta('meta[property="og:url"]', `${window.location.origin}/help`);
    const canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical) canonical.href = `${window.location.origin}/help`;
  }, [selectedContent, selectedDoc.description, selectedDoc.title, systemName]);

  useEffect(() => {
    articleBodyRef.current?.scrollTo?.({ top: 0 });
  }, [selectedDoc.id]);

  const headings = useMemo(() => (renderedContent ? extractHeadings(renderedContent) : []), [renderedContent]);
  const normalizedQuery = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!normalizedQuery) return [];
    return HELP_DOCS.filter((doc) => {
      const category = getCategory(doc.category);
      return [doc.title, doc.description, category.label, contents[doc.id] || '']
        .join('\n')
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [contents, normalizedQuery]);

  const selectDoc = (id: string) => {
    const doc = getHelpDoc(id);
    if (!doc) return;
    setSelectedId(doc.id);
    setQuery('');
    const url = new URL(window.location.href);
    url.pathname = '/help';
    url.searchParams.set('doc', doc.id);
    window.history.pushState({}, '', url.toString());
    window.setTimeout(() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };

  const scrollToHeading = (index: number) => {
    const nodes = articleBodyRef.current?.querySelectorAll('h2, h3');
    nodes?.[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="help-page">
      <header className="help-header">
        <a className="help-brand" href="/" aria-label={`返回${systemName}`}>
          <img src={logoSrc} alt="" />
          <span>{systemName}</span>
        </a>
        <span className="help-header-divider">帮助中心</span>
        <nav className="help-header-nav" aria-label="帮助中心导航">
          <a href="/#lm-features">产品功能</a>
          <a href="/#lm-pricing">定价</a>
          <a className="help-header-cta" href="/">登录 / 使用</a>
        </nav>
      </header>

      <main className="help-main">
        <section className="help-hero">
          <div className="help-hero-inner">
            <span className="help-eyebrow">帮助中心 · HELP CENTER</span>
            <h1>先看说明，再开始写标书。</h1>
            <p className="help-hero-lead">
              从上传招标文件、配置模型，到生成目录正文、查重和导出，按步骤整理在这里。
              遇到问题也可以先搜一下，大部分卡点都有答案。
            </p>
            <div className={`help-search ${searchFocused ? 'is-focused' : ''}`}>
              <svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setQuery('');
                }}
                placeholder="搜索功能、报错或操作步骤，例如：解析失败"
                aria-label="搜索帮助文档"
              />
              {query && (
                <button type="button" className="help-search-clear" onClick={() => setQuery('')} aria-label="清空搜索">
                  ×
                </button>
              )}
            </div>
            <div className="help-hot">
              <span>热门：</span>
              <button type="button" onClick={() => selectDoc('usage-01')}>生成技术方案</button>
              <button type="button" onClick={() => selectDoc('config-01')}>配置文本模型</button>
              <button type="button" onClick={() => selectDoc('usage-06')}>下一步不能点击</button>
            </div>
          </div>
          <div className="help-hero-stats" aria-label="帮助中心统计">
            <div><strong>{HELP_DOCS.length}</strong><span>篇指南</span></div>
            <div><strong>{HELP_CATEGORIES.length}</strong><span>个主题</span></div>
            <div><strong>持续</strong><span>更新中</span></div>
          </div>
        </section>

        <div className={`help-layout ${normalizedQuery ? 'is-searching' : ''}`}>
          <aside className="help-sidebar" aria-label="帮助文档目录">
            {HELP_CATEGORIES.map((category) => {
              const docs = HELP_DOCS.filter((doc) => doc.category === category.id);
              if (docs.length === 0) return null;
              return (
                <div className="help-nav-group" key={category.id}>
                  <div className="help-nav-label">
                    <span>{category.label}</span>
                    <small>{docs.length}</small>
                  </div>
                  {docs.map((doc) => (
                    <button
                      type="button"
                      key={doc.id}
                      className={`help-nav-link ${!normalizedQuery && doc.id === selectedDoc.id ? 'is-active' : ''}`}
                      onClick={() => selectDoc(doc.id)}
                    >
                      <i aria-hidden="true" />
                      <span>{doc.title}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </aside>

          <section className="help-panel" ref={panelRef}>
            <div className="help-mobile-picker">
              <label htmlFor="help-doc-select">选择文档</label>
              <select
                id="help-doc-select"
                value={selectedDoc.id}
                onChange={(event) => selectDoc(event.target.value)}
              >
                {HELP_CATEGORIES.map((category) => {
                  const docs = HELP_DOCS.filter((doc) => doc.category === category.id);
                  if (docs.length === 0) return null;
                  return (
                    <optgroup label={category.label} key={category.id}>
                      {docs.map((doc) => <option key={doc.id} value={doc.id}>{doc.title}</option>)}
                    </optgroup>
                  );
                })}
              </select>
            </div>

            {normalizedQuery ? (
              <div className="help-results">
                <div className="help-results-head">
                  <span className="help-eyebrow">搜索结果</span>
                  <h1>“{query.trim()}”</h1>
                  <p>
                    {loadState === 'loading'
                      ? '正在搜索全部文档…'
                      : `找到 ${searchResults.length} 篇相关文档${searchResults.length === 0 ? '，换个关键词试试' : ''}`}
                  </p>
                </div>
                {searchResults.length > 0 ? (
                  <div className="help-result-list">
                    {searchResults.map((doc) => (
                      <button type="button" className="help-result" key={doc.id} onClick={() => selectDoc(doc.id)}>
                        <span className="help-result-cat">{getCategory(doc.category).label}</span>
                        <strong>{doc.title}</strong>
                        <p>{searchSnippet(doc, normalizedQuery, contents[doc.id])}</p>
                        <span className="help-result-arrow" aria-hidden="true">→</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="help-empty">
                    <strong>没有找到匹配的文档</strong>
                    <p>试试更短的关键词，或直接查看下面的常见问题。</p>
                    <div>
                      <button type="button" className="help-btn-primary" onClick={() => selectDoc('usage-06')}>打开常见问题</button>
                      <button type="button" className="help-btn-ghost" onClick={() => setQuery('')}>清空搜索</button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <article className="help-article">
                <div className="help-breadcrumb">
                  <button type="button" onClick={() => setQuery('')}>帮助中心</button>
                  <span>/</span>
                  <span>{selectedCategory.label}</span>
                  <span>/</span>
                  <span>{selectedDoc.title}</span>
                </div>

                <header className="help-article-head">
                  <span className="help-category-pill">{selectedCategory.label}</span>
                  <h1>{selectedDoc.title}</h1>
                  <p>{selectedDoc.description}</p>
                  <div className="help-article-meta">
                    <span>约 {selectedContent ? estimateReadMinutes(selectedContent) : 2} 分钟阅读</span>
                    <span>·</span>
                    <span>{selectedDoc.category === 'config' ? '配置与接入' : '使用教程'}</span>
                  </div>
                </header>

                {loadState === 'loading' && (
                  <div className="help-article-skeleton" aria-label="正在加载文档">
                    <i /><i /><i /><i /><i />
                  </div>
                )}
                {loadState === 'error' && (
                  <div className="help-article-state">
                    <strong>文档加载失败</strong>
                    <p>请检查网络后重试；如果持续失败，可以联系管理员。</p>
                    <button type="button" className="help-btn-primary" onClick={() => setReloadToken((value) => value + 1)}>重新加载</button>
                  </div>
                )}
                {loadState === 'ready' && selectedContent && (
                  <div className="markdown-viewer help-article-body" ref={articleBodyRef}>
                    <MarkdownRenderer imageMode="lazy">{renderedContent}</MarkdownRenderer>
                  </div>
                )}

                {loadState === 'ready' && (
                  <div className="help-pager">
                    {previousDoc ? (
                      <button type="button" onClick={() => selectDoc(previousDoc.id)}>
                        <span>上一篇</span>
                        <strong>{previousDoc.title}</strong>
                      </button>
                    ) : <span />}
                    {nextDoc ? (
                      <button type="button" className="is-next" onClick={() => selectDoc(nextDoc.id)}>
                        <span>下一篇</span>
                        <strong>{nextDoc.title}</strong>
                      </button>
                    ) : <span />}
                  </div>
                )}

                <div className="help-help-cta">
                  <div>
                    <strong>还是没有解决？</strong>
                    <p>登录后在「问题 FAQ」里提交问题，管理员回复会同步到站内。</p>
                  </div>
                  <a href="/">登录后提交问题</a>
                </div>
              </article>
            )}
          </section>

          {!normalizedQuery && headings.length > 1 && (
            <aside className="help-toc" aria-label="本页目录">
              <p>本页目录</p>
              {headings.map((heading, index) => (
                <button
                  type="button"
                  key={`${heading.text}-${index}`}
                  className={heading.level === 3 ? 'is-sub' : undefined}
                  onClick={() => scrollToHeading(index)}
                >
                  {heading.text}
                </button>
              ))}
            </aside>
          )}
        </div>
      </main>

      <footer className="help-footer">
        <span>
          © 2026 {systemName} · 帮助中心 · 成都解台网络科技有限公司 ·{' '}
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">蜀ICP备2026063732号-1</a>
        </span>
        <span className="help-footer-links">
          <a href="/agreement-user.html" target="_blank" rel="noreferrer">用户协议</a>
          <a href="/agreement-privacy.html" target="_blank" rel="noreferrer">隐私政策</a>
          <a href="/">返回首页</a>
        </span>
      </footer>
    </div>
  );
}
