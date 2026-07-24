import "./styles.css";

const icon = (name, className = "") => {
  const paths = {
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    shield:
      '<path d="M12 3 5 6v5c0 4.7 2.7 8.1 7 10 4.3-1.9 7-5.3 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
    file:
      '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 13h6M9 17h4"/>',
    link:
      '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/>',
    balance:
      '<path d="M12 3v18M5 6h14M7 6l-4 7h8L7 6ZM17 6l-4 7h8l-4-7ZM8 21h8"/>',
    alert:
      '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5M12 17.5v.5"/>',
    eye:
      '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
    lock:
      '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
  };
  return `<svg class="${className}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
};

document.querySelector("#app").innerHTML = `
  <header class="site-header" data-header>
    <nav class="nav-shell" aria-label="主导航">
      <a class="brand" href="#top" aria-label="iAgent Finance 首页">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>iAgent</span>
        <span class="brand-divider"></span>
        <span class="brand-product">Finance</span>
      </a>
      <div class="nav-links" data-nav-links>
        <a href="#top">Auto Voucher</a>
        <a href="#early-access">首发通知</a>
      </div>
      <div class="nav-actions">
        <a class="text-link desktop-only" href="https://www.iagent7.com/">iAgent7 官网</a>
        <a class="nav-cta" href="#early-access">获取首发通知 ${icon("arrow")}</a>
        <button class="menu-button" data-menu-button aria-expanded="false" aria-label="打开导航">
          <span data-menu-icon>${icon("menu")}</span>
        </button>
      </div>
    </nav>
  </header>

  <main id="top">
    <section class="hero section-shell" aria-labelledby="hero-title">
      <div class="aurora aurora-one"></div>
      <div class="aurora aurora-two"></div>
      <div class="hero-copy">
        <div class="eyebrow reveal"><span></span> iAgent Finance · 首个产品</div>
        <h1 id="hero-title" class="reveal">财务凭证自动化</h1>
        <p class="hero-lead reveal">
          Auto Voucher 在企业本地读取业务资料、匹配单据，生成可审核的凭证草稿。
          重复工作交给流程，不确定的事项留给财务人员。
        </p>
        <div class="hero-actions reveal">
          <a class="button button-primary" href="#early-access">获取首发通知 ${icon("arrow")}</a>
          <a class="button button-quiet" href="https://www.iagent7.com/products">浏览 iAgent7 产品</a>
        </div>
        <div class="hero-notes reveal" aria-label="产品特点">
          <span>${icon("lock")} 本地优先</span>
          <span>${icon("eye")} 全程可追溯</span>
          <span>${icon("check")} 人工确认后推送</span>
        </div>
      </div>

      <div class="hero-visual reveal" aria-label="从原始资料到凭证草稿的流程示意">
        <div class="visual-orbit orbit-one"></div>
        <div class="visual-orbit orbit-two"></div>
        <article class="source-sheet sheet-invoice">
          <div class="sheet-head"><span>数电发票</span><small>XML</small></div>
          <strong>¥ 28,460.00</strong>
          <div class="sheet-lines"><i></i><i></i><i></i></div>
          <span class="match-stamp">${icon("check")} 已识别</span>
        </article>
        <article class="source-sheet sheet-bank">
          <div class="sheet-head"><span>银行流水</span><small>XLSX</small></div>
          <div class="bank-row"><span>远山科技</span><b>−28,460.00</b></div>
          <div class="bank-row dim"><span>星野办公</span><b>−3,280.00</b></div>
        </article>
        <div class="flow-thread">
          <i></i><i></i><i></i>
        </div>
        <article class="voucher-card">
          <div class="voucher-top">
            <div>
              <span class="voucher-kicker">凭证草稿</span>
              <h2>记 · 0042</h2>
            </div>
            <span class="status-badge">${icon("check")} 借贷平衡</span>
          </div>
          <div class="voucher-meta">
            <span>2026.07.24</span><span>采购付款</span><span>附件 3</span>
          </div>
          <div class="voucher-table">
            <div class="table-head"><span>摘要 / 科目</span><span>借方</span><span>贷方</span></div>
            <div class="voucher-row">
              <span><b>采购办公设备</b><small>1601 · 固定资产</small></span>
              <strong>28,460.00</strong><strong>—</strong>
            </div>
            <div class="voucher-row">
              <span><b>支付远山科技</b><small>1002 · 银行存款</small></span>
              <strong>—</strong><strong>28,460.00</strong>
            </div>
          </div>
          <div class="voucher-foot">
            <span>${icon("link")} 3 份来源资料</span>
            <span>等待人工确认</span>
          </div>
        </article>
        <div class="exception-pill">${icon("alert")} 发现 1 处金额差异</div>
      </div>
    </section>

    <section class="early-access section-shell" id="early-access">
      <div class="cta-card">
        <div class="cta-aurora"></div>
        <div>
          <span class="cta-label">FIRST RELEASE · AUTO VOUCHER</span>
          <h2>第一版，正在把复杂的资料<br />整理成清晰的凭证草稿。</h2>
        </div>
        <div class="cta-action">
          <p>产品发布、演示数据与本地安装包准备好后，第一时间告诉你。</p>
          <a class="button button-primary" href="https://www.iagent7.com/contact">获取首发通知 ${icon("arrow")}</a>
        </div>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="section-shell footer-grid">
      <div class="footer-brand">
        <a class="brand brand-light" href="#top">
          <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <span>iAgent</span><span class="brand-divider"></span><span class="brand-product">Finance</span>
        </a>
        <p>Focused finance products for real work.</p>
      </div>
      <div class="footer-links">
        <div><strong>产品</strong><a href="#top">Auto Voucher</a><a href="#early-access">首发通知</a></div>
        <div><strong>iAgent7</strong><a href="https://www.iagent7.com/products">所有产品</a><a href="https://www.iagent7.com/about">关于</a><a href="https://www.iagent7.com/contact">联系</a></div>
        <div><strong>语言</strong><a href="#" aria-current="page">简体中文</a><a href="#" data-language-soon>English · Soon</a></div>
      </div>
    </div>
    <div class="section-shell footer-bottom">
      <span>© 2026 iAgent7 · Shanghai Aijingte Artificial Intelligence Technology Co., Ltd.</span>
      <span>finance.iagent7.com</span>
    </div>
  </footer>
`;

const menuButton = document.querySelector("[data-menu-button]");
const navLinks = document.querySelector("[data-nav-links]");
const menuIcon = document.querySelector("[data-menu-icon]");

menuButton.addEventListener("click", () => {
  const isOpen = menuButton.getAttribute("aria-expanded") === "true";
  menuButton.setAttribute("aria-expanded", String(!isOpen));
  menuButton.setAttribute("aria-label", isOpen ? "打开导航" : "关闭导航");
  navLinks.classList.toggle("open", !isOpen);
  menuIcon.innerHTML = icon(isOpen ? "menu" : "close");
});

navLinks.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    navLinks.classList.remove("open");
    menuButton.setAttribute("aria-expanded", "false");
    menuIcon.innerHTML = icon("menu");
  });
});

document.querySelector("[data-language-soon]").addEventListener("click", (event) => {
  event.preventDefault();
});

const header = document.querySelector("[data-header]");
const observer = new IntersectionObserver(
  ([entry]) => header.classList.toggle("scrolled", !entry.isIntersecting),
  { threshold: 0.1 },
);
observer.observe(document.querySelector(".hero"));

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12 },
);

document
  .querySelectorAll(".cta-card")
  .forEach((element) => {
    element.classList.add("scroll-reveal");
    revealObserver.observe(element);
  });
