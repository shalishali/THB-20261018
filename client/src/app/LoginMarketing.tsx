// 登录页左侧营销栏：B 端简约商务风「产品介绍 + 登录」合一页。
// 信息架构：Hero → 工作台示意 → 四步流程 → 功能矩阵（王牌高亮）→ 能力对比 → 定价
//          → 适用场景 → 数据安全与合规 → FAQ → 页脚。
// 文案全部原创、对齐产品真实能力；不承诺中标率、不虚构案例；免责声明固定保留。
interface LoginMarketingProps {
  /** 点击转化 CTA / 王牌功能卡时，把右侧登录卡切到注册 tab */
  onRegister: () => void;
}

function LmIcon({ d, size = 22 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ICON_UPLOAD = 'M12 15V4m0 0L7 9m5-5l5 5M4 20h16';
const ICON_DOC = 'M6 3h9l4 4v14H6zM9 11h6M9 15h6';
const ICON_LIST = 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01';
const ICON_DOWNLOAD = 'M6 3h9l4 4v14H6zM12 8v7m0 0l-3-3m3 3l3-3';
const ICON_SHIELD = 'M12 3l7 3v5c0 4.5-3 7.6-7 10-4-2.4-7-5.5-7-10V6zM9 11.5l2 2 4-4.5';
const ICON_BUILDING = 'M4 21h16M6 21V4h8v17M14 9h4v12M9 8h.01M9 12h.01M9 16h.01';
const ICON_CASE = 'M4 8h16v12H4zM9 8V5h6v3M4 13h16';
const ICON_BOX = 'M4 8l8-4 8 4v9l-8 4-8-4zM4 8l8 4 8-4M12 12v9';

export function LoginMarketing({ onRegister }: LoginMarketingProps) {
  return (
    <div className="lm" aria-label="产品介绍">
      {/* Hero：废标痛点 + 三条短卖点 + 主次 CTA */}
      <header className="lm-hero">
        <span className="lm-kicker">AI 标书工作台 · 面向投标经办人</span>
        <h1 className="lm-title">
          别让一份标书，
          <br />
          <em>毁在漏看的废标条款上。</em>
        </h1>
        <ul className="lm-points">
          <li>废标红线，交稿前自动排查</li>
          <li>评分点逐条拆解，目录正文对齐生成</li>
          <li>查重、废标项、一致性三重自检</li>
        </ul>
        <div className="lm-hero-cta">
          <button type="button" className="lm-btn-primary" onClick={onRegister}>
            免费注册，领取 10 万字额度
          </button>
          <a className="lm-btn-ghost" href="#lm-features">先看功能</a>
        </div>
      </header>

      {/* 工作台界面示意（CSS 线框，非实拍截图） */}
      <div className="lm-shot" aria-hidden="true">
        <div className="lm-shot-bar"><i /><i /><i /><span>投好标 · 技术方案工作台</span></div>
        <div className="lm-shot-body">
          <div className="lm-shot-side"><b className="on" /><b /><b /><b /><b /></div>
          <div className="lm-shot-main">
            <i className="t" /><i className="w90" /><i className="w70" /><i className="w80" /><i className="w60" />
          </div>
        </div>
        <div className="lm-shot-foot">产品界面示意</div>
      </div>

      {/* 四步流程：横向四步 */}
      <section className="lm-sec" id="lm-flow">
        <h2>四步生成标书</h2>
        <div className="lm-steps">
          <div className="lm-step">
            <span className="lm-ico"><LmIcon d={ICON_UPLOAD} /></span>
            <b className="lm-no">01</b>
            <h3>上传招标文件</h3>
            <p>docx / pdf / doc / wps 均可</p>
          </div>
          <div className="lm-step">
            <span className="lm-ico"><LmIcon d={ICON_DOC} /></span>
            <b className="lm-no">02</b>
            <h3>解析招标要求</h3>
            <p>评分点、废标项自动成清单</p>
          </div>
          <div className="lm-step">
            <span className="lm-ico"><LmIcon d={ICON_LIST} /></span>
            <b className="lm-no">03</b>
            <h3>生成目录正文</h3>
            <p>逐节成稿，随手可编辑</p>
          </div>
          <div className="lm-step">
            <span className="lm-ico"><LmIcon d={ICON_DOWNLOAD} /></span>
            <b className="lm-no">04</b>
            <h3>检查并导出</h3>
            <p>Word 模板排版，导出即交</p>
          </div>
        </div>
      </section>

      {/* 功能矩阵：废标检查 / 招标解析为王牌，视觉高亮；一句话价值描述 */}
      <section className="lm-sec" id="lm-features">
        <h2>核心功能</h2>
        <div className="lm-feats">
          <div className="lm-feat key" onClick={onRegister}>
            <h3>废标项检查</h3>
            <p>一票否决风险，交稿前自动排查。</p>
          </div>
          <div className="lm-feat key" onClick={onRegister}>
            <h3>招标文件解析</h3>
            <p>评分细则逐条拆解，不用通读上百页。</p>
          </div>
          <div className="lm-feat" onClick={onRegister}>
            <h3>标书查重</h3>
            <p>多份标书先查重复，再交不撞车。</p>
          </div>
          <div className="lm-feat" onClick={onRegister}>
            <h3>已有方案扩写</h3>
            <p>老方案补厚度，骨架不动。</p>
          </div>
          <div className="lm-feat" onClick={onRegister}>
            <h3>目录与正文生成</h3>
            <p>对齐评分点，逐节成稿。</p>
          </div>
          <div className="lm-feat" onClick={onRegister}>
            <h3>Word 模板导出</h3>
            <p>导出即排版，免调格式。</p>
          </div>
        </div>
      </section>

      {/* 能力对比 */}
      <section className="lm-sec" id="lm-compare">
        <h2>和通用 AI、传统人工比一比</h2>
        <div className="lm-table-wrap">
          <table>
            <thead>
              <tr><th>能力</th><th>投好标</th><th>通用大模型</th><th>传统人工</th></tr>
            </thead>
            <tbody>
              <tr><th>废标红线排查</th><td className="lm-yes">✓ 自动逐条</td><td className="lm-no2">无</td><td className="lm-part">靠老手</td></tr>
              <tr><th>评分点拆解</th><td className="lm-yes">✓ 自动成清单</td><td className="lm-part">长文易漏</td><td className="lm-part">凭经验</td></tr>
              <tr><th>目录正文生成</th><td className="lm-yes">✓ 对齐评分点</td><td className="lm-part">难控制</td><td className="lm-no2">按天计</td></tr>
              <tr><th>标书查重</th><td className="lm-yes">✓ 内置</td><td className="lm-no2">无</td><td className="lm-no2">不做</td></tr>
              <tr><th>Word 排版导出</th><td className="lm-yes">✓ 模板化</td><td className="lm-part">要自己排</td><td className="lm-yes">✓ 但耗时</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* 定价 */}
      <section className="lm-sec" id="lm-pricing">
        <h2>定价</h2>
        <p className="lm-sub">解析与大纲免费；正文按字数消耗；同内容重复导出不重复扣费。</p>
        <div className="lm-prices">
          <div className="lm-price">
            <h3>免费体验</h3>
            <p className="lm-price-num">10 万字</p>
            <p className="lm-price-note">注册即送，解析永久免费</p>
          </div>
          <div className="lm-price">
            <h3>10 万字包</h3>
            <p className="lm-price-num">¥3.9</p>
            <p className="lm-price-note">单份标书够用</p>
          </div>
          <div className="lm-price">
            <h3>20 万字包</h3>
            <p className="lm-price-num">¥5</p>
            <p className="lm-price-note">多轮修改</p>
          </div>
          <div className="lm-price hot">
            <span className="lm-price-badge">常用</span>
            <h3>50 万字包</h3>
            <p className="lm-price-num">¥10</p>
            <p className="lm-price-note">多项目并行</p>
          </div>
        </div>
        <p className="lm-price-more">另有 110 万字 ¥20 套餐，注册后站内可选；额度长期有效。</p>
      </section>

      {/* 适用场景 */}
      <section className="lm-sec" id="lm-scenes">
        <h2>适用场景</h2>
        <div className="lm-scenes">
          <div className="lm-scene">
            <span className="lm-ico"><LmIcon d={ICON_SHIELD} size={18} /></span>
            <h3>政府采购</h3>
            <p>逐项响应评分办法</p>
          </div>
          <div className="lm-scene">
            <span className="lm-ico"><LmIcon d={ICON_BUILDING} size={18} /></span>
            <h3>工程投标</h3>
            <p>施组与方案快速成稿</p>
          </div>
          <div className="lm-scene">
            <span className="lm-ico"><LmIcon d={ICON_CASE} size={18} /></span>
            <h3>服务类项目</h3>
            <p>运维咨询方案编写</p>
          </div>
          <div className="lm-scene">
            <span className="lm-ico"><LmIcon d={ICON_BOX} size={18} /></span>
            <h3>货物类项目</h3>
            <p>技术响应参数对照</p>
          </div>
        </div>
      </section>

      {/* 数据安全与合规 */}
      <section className="lm-sec" id="lm-trust">
        <h2>数据安全与合规</h2>
        <div className="lm-trusts">
          <div className="lm-trust"><b>数据按用户隔离</b><span>项目与文件仅本账号可见</span></div>
          <div className="lm-trust"><b>源码公开可审计</b><span>基于 AGPL-3.0 开源项目</span></div>
          <div className="lm-trust"><b>支持私有化部署</b><span>数据完全自持</span></div>
          <div className="lm-trust"><b>密钥仅存服务端</b><span>API Key 不下发浏览器</span></div>
        </div>
        <p className="lm-trust-note">适配政府采购、工程投标等场景；政采项目请以招标文件要求为准逐条复核。</p>
      </section>

      {/* FAQ：业务痛点优先 */}
      <section className="lm-sec" id="lm-faq">
        <h2>常见问题</h2>
        <details className="lm-faq" open>
          <summary>政府采购、工程类标书能用吗？</summary>
          <p>可以。目录按评分办法对齐，支持章节化写作与废标条款对照；政采项目以招标文件要求为准复核。</p>
        </details>
        <details className="lm-faq">
          <summary>导出的 Word 格式合规吗？</summary>
          <p>标题层级、编号、页眉页脚按模板排版，导出即可装订提交。</p>
        </details>
        <details className="lm-faq">
          <summary>AI 生成的标书能直接提交吗？</summary>
          <p>不能。AI 出的是初稿，正式投标前务必逐条人工复核。</p>
        </details>
        <details className="lm-faq">
          <summary>我的招标文件和数据安全吗？</summary>
          <p>数据按用户隔离，仅本账号可见；支持私有化部署。</p>
        </details>
        <details className="lm-faq">
          <summary>怎么收费？</summary>
          <p>注册送 10 万字；解析免费，正文按字数消耗；同内容不重复扣费。</p>
        </details>
        <details className="lm-faq">
          <summary>是开源的吗？</summary>
          <p>基于 OpenBidKit-Yibiao（AGPL-3.0）二次开发，源码可审计。</p>
        </details>
      </section>

      {/* 极简页脚 */}
      <footer className="lm-footer">
        <span>© 2026 投好标 · 基于 OpenBidKit-Yibiao（AGPL-3.0）二次开发</span>
        <span className="lm-footer-links">
          <a href="/agreement-user.html" target="_blank" rel="noreferrer">用户协议</a>
          <a href="/agreement-privacy.html" target="_blank" rel="noreferrer">隐私政策</a>
        </span>
      </footer>
      <p className="lm-foot">
        AI 生成内容仅供辅助参考，不能替代人工审核；正式投标前请按招标文件要求逐条人工复核。
      </p>
    </div>
  );
}
