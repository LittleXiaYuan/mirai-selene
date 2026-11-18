"""真实浏览器里的用户流程测试：注册 → 走一个选择 → 刷新验证世界还在。

这一步验证的是前端与后端的实际对接（useSession / pushWorld / mergeRemote），
而不是 API 本身 —— API 已经由 test_auth.py 覆盖。
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from cdp import connect, open_page  # noqa: E402

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9335
URL = sys.argv[1] if len(sys.argv) > 1 else "https://mirai.cloudtori.cn/app.html"
W, H = 390, 844

RESULTS = []


def check(label, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {label} {detail}")
    RESULTS.append((label, cond))


SET_INPUT = """
(() => {
  const el = document.querySelector('[data-test="%s"]');
  if (!el) return 'NOEL';
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, %s);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()
"""


def set_by_id(c, el_id, value):
    import json as js

    return c.eval(SET_INPUT % (el_id, js.dumps(value)))


def main():
    proc, c = connect(CHROME, PORT, os.path.join(os.environ.get("TEMP", "/tmp"), "mirai-flow"), W, H)
    email = f"browser{int(time.time())}@example.com"
    try:
        open_page(c, URL, W, H)

        # 首页应能打开
        txt = c.eval("document.body.innerText") or ""
        check("首页渲染", "走进这个世界" in txt, f"len={len(txt)}")

        # 进登录页
        c.eval("""(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='登录'); if(b) b.click(); return 1; })()""")
        time.sleep(1.4)
        txt = c.eval("document.body.innerText") or ""
        check("到达登录页", "回到你的世界" in txt, txt[:40])

        # 切到注册
        c.eval("""(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='注册一个'); if(b) b.click(); return 1; })()""")
        time.sleep(0.8)

        # 填表单（用 id 直接定位，Arc Input 渲染成原生 input）
        c.eval(f"""(() => {{
          const set = (id, v) => {{
            const el = document.getElementById(id);
            if (!el) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, v);
            el.dispatchEvent(new Event('input', {{ bubbles: true }}));
            return true;
          }};
          const ok1 = set('a-email', {email!r});
          const ok2 = set('a-name', '浏览器测试');
          const ok3 = set('a-pass', 'browsertest123');
          return [ok1, ok2, ok3].join(',');
        }})()""")
        time.sleep(0.6)

        # 提交
        c.eval("""(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').includes('建好账号')); if(b) b.click(); return 1; })()""")
        time.sleep(4)

        txt = c.eval("document.body.innerText") or ""
        check("注册后回到首页", "走进这个世界" in txt, txt[:60])
        check("首页显示用户名", "浏览器测试" in txt, "")

        # 走进世界，做一个选择
        c.eval("""(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').includes('走进这个世界')); if(b) b.click(); return 1; })()""")
        time.sleep(2)
        before = c.eval("document.body.innerText") or ""
        check("进入 Stage", "这条世界线" in before, "")

        c.eval("""(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').includes('去上海')); if(b) b.click(); return 1; })()""")
        time.sleep(2.5)
        after = c.eval("document.body.innerText") or ""
        check("选择后时间线变长", after.count("去上海") >= 1, "")

        # 等同步（防抖 1.2s + 网络）
        time.sleep(3)

        # 刷新页面，世界应该从服务端回来
        c.call("Page.reload")
        time.sleep(5)
        c.wait_ready()
        reloaded = c.eval("document.body.innerText") or ""
        check("刷新后仍是登录态", "浏览器测试" in reloaded, reloaded[:50])
        check("刷新后世界还在", "林夏的毕业选择" in reloaded, "")

        # 检查 localStorage 里也确实有树
        nodes = c.eval("""(() => {
          const raw = localStorage.getItem('mirai.app.v2');
          if (!raw) return -1;
          const arr = JSON.parse(raw);
          return arr[0] && arr[0].tree ? Object.keys(arr[0].tree.nodes).length : -1;
        })()""")
        check("本地世界有节点", isinstance(nodes, int) and nodes > 5, f"nodes={nodes}")

        print()
        passed = sum(1 for _, ok in RESULTS if ok)
        print(f"{passed}/{len(RESULTS)} 通过")
        return 0 if passed == len(RESULTS) else 1
    finally:
        c.close()
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
