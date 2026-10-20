// 统一设置浏览器标签图标：登录页和应用内都要跟随系统 Logo。
// 直接改 <link rel="icon"> 的 href 在部分浏览器（尤其 data URL/类型变化时）不会立即刷新，
// 这里重建 link 节点并显式设置 MIME，避免继续使用 index.html 里的默认 icon.svg。
function faviconMimeType(src: string): string {
  const value = String(src || '').trim();
  if (/^data:image\/svg\+xml/i.test(value)) return 'image/svg+xml';
  if (/^data:image\/png/i.test(value)) return 'image/png';
  if (/^data:image\/jpeg/i.test(value)) return 'image/jpeg';
  if (/^data:image\/webp/i.test(value)) return 'image/webp';
  if (/\.svg(?:[?#]|$)/i.test(value)) return 'image/svg+xml';
  if (/\.jpe?g(?:[?#]|$)/i.test(value)) return 'image/jpeg';
  if (/\.webp(?:[?#]|$)/i.test(value)) return 'image/webp';
  return 'image/png';
}

export function applyFavicon(src: string | null | undefined): void {
  const href = String(src || '').trim();
  if (!href) return;
  // 移除旧的 icon link（包括 index.html 的默认 icon.svg），避免浏览器继续命中旧图标。
  document.querySelectorAll('link[rel~="icon"]').forEach((node) => node.remove());
  const link = document.createElement('link');
  link.id = 'favicon';
  link.rel = 'icon';
  link.type = faviconMimeType(href);
  link.href = href;
  document.head.appendChild(link);
}
