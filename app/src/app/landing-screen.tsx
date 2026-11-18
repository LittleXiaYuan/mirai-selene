import { ArrowRight, Play } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import styles from "./landing.module.css";

/**
 * 宣传落地页。
 *
 * 结构：不对称首屏（主张 + 视频）→ 聊天框做不到的三件事 → 实机接触印样
 * → 自研状态核 → 收束。不是等宽卡片墙，也不是仪表盘。
 */
export function LandingScreen({
  onEnter,
  onAuth,
  onAbout,
  onMarket,
  onDemo,
  signedInName,
  onWorkspace,
}: {
  onEnter: () => void;
  onAuth: () => void;
  onAbout: () => void;
  onMarket: () => void;
  onDemo?: () => void;
  signedInName?: string;
  onWorkspace: () => void;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.nav}>
        <a className={styles.wordmark} href="/" aria-label="Mirai-Selene 首页">
          Mirai<span>·</span>Selene
        </a>
        <nav className={styles.links} aria-label="站点导航">
          <button type="button" onClick={onMarket}>
            世界市场
          </button>
          <button type="button" onClick={onAbout}>
            边界与基准
          </button>
          {onDemo ? (
            <button type="button" onClick={onDemo}>
              演示模式
            </button>
          ) : null}
          <a href="/watch" target="_blank" rel="noreferrer">
            引擎 Demo
          </a>
        </nav>
        <div className={styles.navActions}>
          {signedInName ? (
            <button type="button" className={styles.navUser} onClick={onWorkspace}>
              {signedInName} · 工作台
            </button>
          ) : (
            <button type="button" className={styles.navUser} onClick={onAuth}>
              登录 / 注册
            </button>
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
            <h1>
              在押上之前，
              <br />
              先走一遍。
            </h1>
            <p className={styles.lede}>
              听得出你在心虚，算得清这一步的生死边界。
              分叉试错，再把两条线的情报无损合流。
            </p>
            <div className={styles.actions}>
              <Button onClick={onEnter}>
                免费进入一个世界
                <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
              </Button>
              <a className={styles.ghostAction} href="/watch" target="_blank" rel="noreferrer">
                <Play size={15} strokeWidth={2} aria-hidden />
                看 78 秒宣传片
              </a>
            </div>
            <ul className={styles.facts} aria-label="核心指标">
              <li>
                <b>23/23</b> 数学不变量
              </li>
              <li>
                <b>2.12e-16</b> 合流误差
              </li>
              <li>
                <b>&lt;5ms</b> 端侧单步
              </li>
            </ul>
          </div>

          <a
            className={styles.heroMedia}
            href="/watch"
            target="_blank"
            rel="noreferrer"
            aria-label="播放 78 秒宣传片"
          >
            <img src="/promo/mirai-promo-poster.jpg" alt="Mirai-Selene 宣传片封面" />
            <span className={styles.mediaTag}>78s · 2K</span>
            <span className={styles.play}>
              <Play size={20} fill="currentColor" strokeWidth={0} aria-hidden />
            </span>
            <span className={styles.mediaCaption}>真实界面与推演过程，不配音也看得懂</span>
          </a>
        </section>

        <section className={styles.failures} aria-labelledby="why-title">
          <h2 id="why-title">聊天框做不到的三件事</h2>
          <div className={styles.failureRows}>
            <article>
              <h3>它听不见语气</h3>
              <p>
                你说“我不怕”，语音转文字只剩七个字。停顿、卡壳、尾音上扬、声带发抖，全被抹平。
                我们把 12 维声学韵律直接写进状态核：越心虚，字面承诺的权重越低。
              </p>
            </article>
            <article>
              <h3>它没法把两条路合起来</h3>
              <p>
                分叉试错之后，传统做法只能让模型写摘要——有损，还容易编。
                我们的两条世界线是自然参数，合流就是加法，顺序无关，重复合并不翻倍。
              </p>
            </article>
            <article>
              <h3>它用平均值掩盖死局</h3>
              <p>
                一边 +9，一边 −9，均值是 0。可现实里没有这个结局。
                我们输出五档分位数与破产危险率，让你先看见最坏能坏到哪。
              </p>
            </article>
          </div>
        </section>

        <section className={styles.sheet} aria-labelledby="sheet-title">
          <div className={styles.sheetHead}>
            <h2 id="sheet-title">把一条热帖，变成一张能走进去的牌桌</h2>
            <p>截图都来自当前版本，不是概念稿。</p>
          </div>
          <div className={styles.sheetGrid}>
            <figure className={styles.shotLarge}>
              <img src="/shots/social-sandbox.png" alt="舆情沙盘：五个阵营与失控率推演" />
              <figcaption>
                <span>01</span>
                热帖拆成五个阵营，连跑三轮，算出失控率与三条应对分支。
              </figcaption>
            </figure>
            <figure>
              <img src="/shots/vn-stage.png" alt="沉浸舞台：界面只留场景、立绘与一句台词" />
              <figcaption>
                <span>02</span>
                选一个身份走进去。80% 画面留给场景与立绘，后台预渲染下一幕。
              </figcaption>
            </figure>
            <figure>
              <img src="/shots/market.png" alt="世界市场：每个世界底板标注人物与风险" />
              <figcaption>
                <span>03</span>
                每个世界都是可导出的资产；底板、分支与合流记录都跟着文件走。
              </figcaption>
            </figure>
          </div>
        </section>

        <section className={styles.engine} aria-labelledby="engine-title">
          <div className={styles.engineText}>
            <h2 id="engine-title">不是给大模型套壳</h2>
            <p>
              自研的 PAI-SSM 负责把人心算准、把分支合对、把底线守住；
              通用大模型只负责把话说漂亮。490M 与 120M 两个权重都已在 4×L20 上实训落地。
            </p>
            <dl className={styles.spec}>
              <div>
                <dt>状态</dt>
                <dd>自然参数 (A, B)，O(1) 显存</dd>
              </div>
              <div>
                <dt>写入</dt>
                <dd>声学韵律调制精度 γ</dd>
              </div>
              <div>
                <dt>输出</dt>
                <dd>Q10–Q90 与 P(ruin)</dd>
              </div>
            </dl>
            <Button variant="secondary" onClick={onAbout}>
              看能力边界与实测数据
            </Button>
          </div>
          <div className={styles.engineArt}>
            <img src="/diagram/architecture.svg" alt="PAI-SSM 状态推演管线" />
          </div>
        </section>

        <section className={styles.close}>
          <h2>
            不用注册，
            <br />
            也能先走一遍。
          </h2>
          <p>登录只是让世界跟着你换设备。不登录，它也存在这台机器上，随时可以导出带走。</p>
          <div className={styles.actions}>
            <Button onClick={onEnter}>
              直接进入
              <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
            </Button>
            <a className={styles.ghostAction} href="/watch" target="_blank" rel="noreferrer">
              <Play size={15} strokeWidth={2} aria-hidden />
              先看 78 秒
            </a>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <span>Mirai-Selene · 云鸢（青岛）人工智能有限公司</span>
        <span className={styles.footerLinks}>
          <button type="button" onClick={onAbout}>
            边界与基准
          </button>
          {onDemo ? (
            <button type="button" onClick={onDemo}>
              演示模式
            </button>
          ) : null}
          <a href="/studio" target="_blank" rel="noreferrer">
            引擎 Demo
          </a>
          <a href="https://github.com/LittleXiaYuan/mirai-selene" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </span>
      </footer>
    </div>
  );
}
