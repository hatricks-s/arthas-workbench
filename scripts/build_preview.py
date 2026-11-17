"""Build a self-contained UI review snapshot. No backend or credentials are included."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]


def main():
    source = ROOT / "workbench" / "static"
    output = ROOT / "docs" / "preview"
    output.mkdir(parents=True, exist_ok=True)
    page = (source / "index.html").read_text(encoding="utf-8")
    page = page.replace('href="/static/style.css"', 'href="./style.css"')
    page = page.replace('<script src="/static/app.js" defer></script>',
        '<script src="./mock.js" defer></script>\n  <script src="./app.js" defer></script>')
    page = page.replace('class="brand" href="/"', 'class="brand" href="./index.html"')
    page = page.replace('<body>', '<body>\n  <div role="note" style="padding:12px 24px;background:#e5f0eb;color:#204e3d;font:13px/1.6 sans-serif;border-bottom:1px solid #b7cec1">'
        '<strong>交互原型 · 模拟数据</strong> — 此页面不访问本机进程、不连接集群、不执行诊断。'
        '请审查布局与操作流程。 <a href="https://github.com/yy568821795-max/arthas-workbench" style="color:inherit">项目说明</a></div>')
    page = page.replace('原型 · 运行状态保存在内存中 · 不自动停止目标 JVM',
                        '界面审查专用 · 全部操作与结果均为模拟')
    target = output / "index.html"
    target.write_text(page, encoding="utf-8")
    print(target)
    for name in ("style.css", "app.js"):
        target = output / name
        shutil.copyfile(source / name, target)
        print(target)


if __name__ == "__main__":
    main()
