# -*- coding: utf-8 -*-
"""本機伺服器。

網頁本體不能用 file:// 直接開——瀏覽器基於安全性不讓 file:// 頁面載入 JS 模組，
整個程式會載不起來。所以要在本機用就得起一個伺服器，這支就是做這件事的
（雙擊「離線啟動.bat」會叫它）。只聽 127.0.0.1，外面連不進來。

加上 --dev 才會多開一個 POST /save，讓瀏覽器把產生的對照圖存回硬碟給人檢查；
那是開發驗證用的，平常不開。
"""
import base64
import os
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "_shots")
DEV = False


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if not DEV or self.path != "/save":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8")
        name, _, payload = body.partition("\n")
        name = os.path.basename(name.strip()) or "shot.png"
        if "," in payload:
            payload = payload.split(",", 1)[1]
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(base64.b64decode(payload))
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")

    def end_headers(self):
        # 不留快取：改了程式卻還跑到舊版，是最浪費時間的一種問題
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


def main():
    global DEV
    args = [a for a in sys.argv[1:]]
    DEV = "--dev" in args
    args = [a for a in args if not a.startswith("--")]
    port = int(args[0]) if args else 8732
    os.chdir(HERE)                      # 服務的一律是這個資料夾，不看啟動時的 cwd

    try:
        srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        # 多半是上一次沒關掉還在跑——那就直接用它，不要讓使用者看到一串紅字
        print("連接埠 %d 已經有東西在用了，直接開啟網頁。" % port)
        webbrowser.open("http://localhost:%d/" % port)
        return

    url = "http://localhost:%d/" % port
    print("標籤條碼檢查　→　%s" % url)
    print("（這個視窗關掉，服務就停止）")
    if "--no-browser" not in sys.argv[1:]:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
