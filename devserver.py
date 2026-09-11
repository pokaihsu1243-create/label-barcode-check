# -*- coding: utf-8 -*-
"""開發用的靜態伺服器，外加一個 POST /save：讓瀏覽器把產生的對照圖存回硬碟，
方便人（或工具）直接開檔檢查。只在本機開發時用，不是上線的一部分。"""
import base64
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_shots")


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/save":
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
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))   # 服務的一律是這個資料夾，不看啟動時的 cwd
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8730
    print("serving on http://localhost:%d  (POST /save -> %s)" % (port, OUT))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
