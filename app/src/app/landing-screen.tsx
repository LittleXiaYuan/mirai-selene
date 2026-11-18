import { ArrowRight, BookOpen, GitBranch, Layers, Mic, Sparkles, Store } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import styles from "./landing.module.css";

/**
 * 宣传落地页。
 *
 * 为什么要有这一页：主站原来一进来就是世界列表，第一次来的人不知道
 * 这是什么。上线产品的首页先回答「它是什么、能干什么、凭什么信」，
 * 再给两个明确动作：直接体验，或看引擎 Demo。
 */
export function LandingScreen({
  onEnter,
  onDemo,
  onAuth,
  onAbout,
  onMarket,
  signedInName,
  onWorkspace,
}: {
  onEnter: () => void;
  onDemo: () => void;
  onAuth: () => void;
  onAbout: () => void;
  onMarket: () => void;
  signedInName?: string;
  onWorkspace: () => void;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.nav}>
        <a className={styles.brand} href="/" aria-label="Mirai-Selene 首页">
          Mirai<span>·</span>Selene
        </a>
        <nav className={styles.navLinks} aria-label="站点导航">
          <button type="button" onClick={onMarket}>
            世界市场
          </button>
          <button type="button" onClick={onAbout}>
            边界与基准
          </button>
          <a href="https://xiayuanovo-mirai-selene.ms.show/" target="_blank" rel="noreferrer">
            引擎 Demo
          </a>
        </nav>
        <div className={styles.navActions}>
          {signedInName ? (
            <Button variant="secondary" size="sm" onClick={onWorkspace}>
              {signedInName} · 工作台
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={onAuth}>
              登录 / 注册
            </Button>
          )}
          <Button size="sm" onClick={onEnter}>
            开始体验
            <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
          </Button>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>社会动力学与平行世界推演</span>
            <h1>
              走进每一个决定，
              <br />
              再走出来。
            </h1>
            <p className={styles.lead}>
              听得出你在心虚，算得清这一步的生死边界。
              先替你在平行世界线里试错、避雷，再把两条路无损合流成一张决策卡。
            </p>
            <div className={styles.heroActions}>
              <Button onClick={onDemo}>
                <Sparkles size={15} strokeWidth={1.75} aria-hidden />
                一键体验演示模式
                <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
              </Button>
              <Button variant="secondary" onClick={onEnter}>
                自由进入世界大厅
              </Button>
            </div>
            <dl className={styles.stats}>
              <div>
                <dt>合流误差</dt>
                <dd>2.12e-16</dd>
              </div>
              <div>
                <dt>嘴硬拆穿</dt>
                <dd>100%</dd>
              </div>
              <div>
                <dt>端侧单步</dt>
                <dd>&lt;5ms</dd>
              </div>
            </dl>
          </div>
          <div className={styles.heroArt} aria-hidden>
            <img src="/mirai/01-cover.webp" alt="" decoding="async" />
            <div className={styles.heroCard}>
              <span>这一步的账</span>
              <strong>「她妈的病」从 6 推到 8</strong>
              <em>暖 4.2 · 紧 7.1 · 绷紧</em>
            </div>
          </div>
        </section>

        <section className={styles.capabilities} aria-labelledby="cap-title">
          <h2 id="cap-title">四件事，缺一件就不成立</h2>
          <div className={styles.grid}>
            <article>
              <Sparkles size={20} strokeWidth={1.6} aria-hidden />
              <h3>造世界</h3>
              <p>一句话，或一条小红书热帖，自动拆出势力、底牌与死穴。</p>
            </article>
            <article>
              <BookOpen size={20} strokeWidth={1.6} aria-hidden />
              <h3>走进去</h3>
              <p>视觉小说式舞台，一次一个选择；按住说话，它听得出你在犹豫。</p>
            </article>
            <article>
              <GitBranch size={20} strokeWidth={1.6} aria-hidden />
              <h3>能反悔</h3>
              <p>分叉、回滚、合并。两条线的经验可以精确相加，不是重新编一遍。</p>
            </article>
            <article>
              <Layers size={20} strokeWidth={1.6} aria-hidden />
              <h3>可带走</h3>
              <p>世界是一个带校验的文件，导出、载入、校验，都归你。</p>
            </article>
          </div>
        </section>

        <section className={styles.showcase} aria-labelledby="show-title">
          <h2 id="show-title">不是聊天框，是能走进去的推演台</h2>
          <div className={styles.screens}>
            <figure>
              <img src="/mirai/07-market.webp" alt="世界市场：带底牌与风险标签的世界列表" loading="lazy" />
              <figcaption>
                <Store size={14} strokeWidth={1.6} aria-hidden />
                世界市场：每个底板都标着人物与风险
              </figcaption>
            </figure>
            <figure>
              <img src="/mirai/04-world.webp" alt="沉浸舞台：场景、立绘与一屏一句的台词" loading="lazy" />
              <figcaption>
                <Mic size={14} strokeWidth={1.6} aria-hidden />
                沉浸舞台：听声辨心，一屏一句
              </figcaption>
            </figure>
            <figure>
              <img src="/mirai/03-insight.webp" alt="世界线树：分支、回滚与合流" loading="lazy" />
              <figcaption>
                <GitBranch size={14} strokeWidth={1.6} aria-hidden />
                世界线树：分叉、回滚、无损合流
              </figcaption>
            </figure>
          </div>
        </section>

        <section className={styles.engine} aria-labelledby="engine-title">
          <div>
            <span className={styles.eyebrow}>自研底层架构</span>
            <h2 id="engine-title">PAI-SSM：不做大模型套壳</h2>
            <p>
              自研状态推演核负责「把人心算准、把分支合对、把底线守住」，
              通用大模型只负责把话说漂亮。490M 主力权重与 120M 端侧权重已实训落地，
              23/23 数学不变量单测通过。
            </p>
            <ul>
              <li>12 维声学韵律 → 异方差写入精度，嘴硬心虚会被降权</li>
              <li>自然参数三路合流：Sₒ = Sₐ + S_b − S_base</li>
              <li>五档生死分位数 + 破产危险率，拒绝用均值掩盖死局</li>
            </ul>
            <Button variant="secondary" onClick={onAbout}>
              看能力边界与实测数据
            </Button>
          </div>
          <div className={styles.engineArt} aria-hidden>
            <img src="/mirai/06-tech.webp" alt="" loading="lazy" />
          </div>
        </section>

        <section className={styles.cta}>
          <h2>不用注册也能走一遍。</h2>
          <p>登录只是让世界跟着你换设备；不登录，它也存在这台机器上，随时能导出带走。</p>
          <div className={styles.heroActions}>
            <Button onClick={onEnter}>
              直接进入
              <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
            </Button>
            <Button variant="secondary" onClick={onAuth}>
              创建账号
            </Button>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <span>Mirai-Selene · 云鸢（青岛）人工智能有限公司</span>
        <span className={styles.footerLinks}>
          <button type="button" onClick={onAbout}>
            边界与基准
          </button>
          <a href="/studio" target="_blank" rel="noreferrer">
            引擎 Demo
          </a>
        </span>
      </footer>
    </div>
  );
}
