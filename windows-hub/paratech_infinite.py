"""Visible, removable Windows launcher. Does not monitor or terminate other processes."""
import base64
import ctypes
from ctypes import wintypes
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import urllib.request
import urllib.error
import urllib.parse
import uuid
import webbrowser
from datetime import datetime
from PIL import Image, ImageTk
from core import verify, decide, timestamp, offline_release, BRAZIL

VERSION = "1.0.0"
BASE = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Paratech" / "Infinite"
CONFIG = BASE / "hub.dat"
EXE = BASE / "Paratech_Infinite.exe"
LOCK = threading.RLock()

class Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_byte))]

def protect(data, decrypt=False):
    buffer = ctypes.create_string_buffer(data)
    incoming = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    outgoing = Blob()
    fn = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    if not fn(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
        raise OSError("Não foi possível proteger o pareamento no Windows.")
    try:
        return ctypes.string_at(outgoing.data, outgoing.size)
    finally:
        ctypes.windll.kernel32.LocalFree(outgoing.data)

def read_config():
    if not CONFIG.exists():
        return {}
    return json.loads(protect(CONFIG.read_bytes(), True))

def save_config(value):
    BASE.mkdir(parents=True, exist_ok=True)
    with LOCK:
        # Separate launcher processes must not share a temporary filename.
        temp = BASE / (str(uuid.uuid4()) + ".tmp")
        temp.write_bytes(protect(json.dumps(value).encode()))
        os.replace(temp, CONFIG)

def call(config, endpoint, body):
    headers = {"Content-Type": "application/json"}
    if config.get("token"):
        headers.update({"Authorization": "Bearer " + config["token"], "X-Installation-Id": config["installationId"]})
    request = urllib.request.Request(config["server"].rstrip("/") + "/device-api/" + endpoint,
                                     data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read()).get("error", "Solicitação recusada pelo portal")
        except Exception:
            detail = "Solicitação recusada pelo portal"
        if error.code in (401, 403) and endpoint == "status":
            detail = "PAREAMENTO_RECUSADO: " + detail
        raise RuntimeError(detail) from error

def shortcuts(config, remove=False):
    # Paths are supplied as JSON data, never interpolated into PowerShell code.
    payload = BASE / (str(uuid.uuid4()) + ".json")
    payload.write_text(json.dumps({"exe": str(EXE), "targets": config.get("targets", []),
                                   "startup": config.get("startup", True), "remove": remove}), encoding="utf-8")
    script = '''$d = Get-Content -LiteralPath $env:PARATECH_SHORTCUT_DATA -Raw | ConvertFrom-Json
$shell = New-Object -ComObject WScript.Shell
$desktop = $shell.SpecialFolders.Item('Desktop')
$startup = $shell.SpecialFolders.Item('Startup')
for($i=0; $i -lt $d.targets.Count; $i++) {
  $name = 'Paratech - ' + [IO.Path]::GetFileNameWithoutExtension($d.targets[$i]) + ' - ' + $i + '.lnk'
  $path = Join-Path $desktop $name
  if($d.remove) { if(Test-Path -LiteralPath $path){ Remove-Item -LiteralPath $path }; continue }
  $link = $shell.CreateShortcut($path); $link.TargetPath=$d.exe; $link.Arguments='--launch ' + $i
  $link.WorkingDirectory=[IO.Path]::GetDirectoryName($d.exe); $link.Description='Atalho gerenciado Paratech'; $link.Save()
}
$path = Join-Path $startup 'Paratech Infinite.lnk'
if($d.remove -or !$d.startup) { if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path} }
else { $link=$shell.CreateShortcut($path);$link.TargetPath=$d.exe;$link.Arguments='--background';$link.WorkingDirectory=[IO.Path]::GetDirectoryName($d.exe);$link.Save() }
'''
    try:
        env = {**os.environ, "PARATECH_SHORTCUT_DATA": str(payload)}
        subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand",
                        base64.b64encode(script.encode("utf-16le")).decode()], env=env, check=True,
                       creationflags=0x08000000, capture_output=True, timeout=30)
    finally:
        payload.unlink(missing_ok=True)

class Hub:
    def __init__(self, root, launch=None):
        self.root, self.launch = root, launch
        self.config = read_config()
        self.lease = None
        self.notice = None
        self.pending = False
        self.stopped = False
        self.clock_base = time.time()
        self.monotonic_base = time.monotonic()
        self.last_error = ""
        root.title("Paratech Infinite — Hub de cobranças")
        root.geometry("620x470")
        root.protocol("WM_DELETE_WINDOW", self.close)
        if not self.config:
            self.setup()
        else:
            self.dashboard()
            self.refresh()
            root.after(60000, self.tick)

    def close(self):
        self.stopped = True
        self.root.destroy()

    def async_action(self, job, done):
        if self.pending:
            return
        self.pending = True
        def work():
            try:
                result, error = job(), None
            except Exception as exc:
                result, error = None, str(exc)
            if not self.stopped:
                self.root.after(0, lambda: finish(result, error))
        def finish(result, error):
            self.pending = False
            done(result, error)
        threading.Thread(target=work, daemon=True).start()

    def setup(self):
        frame = ttk.Frame(self.root, padding=18)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="Parear este computador", font=("Segoe UI", 17, "bold")).pack(anchor="w")
        ttk.Label(frame, text="O controle vale somente para os atalhos criados pelo Hub.\nOs programas originais não serão modificados.").pack(anchor="w", pady=8)
        ttk.Label(frame, text="Endereço do portal (HTTPS)").pack(anchor="w")
        server = ttk.Entry(frame); server.insert(0, "https://zaphub-production.up.railway.app"); server.pack(fill="x")
        ttk.Label(frame, text="Código de pareamento — gere na aba Hubs").pack(anchor="w", pady=(8, 0))
        code = ttk.Entry(frame); code.pack(fill="x")
        targets = []
        listing = tk.StringVar(value="Nenhum programa selecionado")
        def choose():
            paths = filedialog.askopenfilenames(title="Programas que serão abertos pelos atalhos", filetypes=[("Executáveis Windows", "*.exe")])
            if paths:
                targets[:] = list(paths); listing.set("\n".join(Path(p).name for p in targets))
        ttk.Button(frame, text="Selecionar programas (.exe)", command=choose).pack(anchor="w", pady=8)
        ttk.Label(frame, textvariable=listing, wraplength=560).pack(anchor="w")
        startup = tk.BooleanVar(value=True)
        ttk.Checkbutton(frame, text="Iniciar o Hub minimizado com o Windows", variable=startup).pack(anchor="w", pady=8)
        consent = tk.BooleanVar(value=False)
        ttk.Checkbutton(frame, text="Autorizo o pareamento e a criação dos atalhos neste computador", variable=consent).pack(anchor="w")
        def install():
            url = server.get().strip().rstrip("/")
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme != "https" or not parsed.hostname or parsed.path or parsed.query or parsed.username:
                messagebox.showerror("Endereço", "Use o endereço HTTPS do portal, sem caminhos."); return
            if not consent.get() or not targets:
                messagebox.showerror("Instalação", "Selecione os programas e autorize a criação dos atalhos."); return
            config = {"server": url, "installationId": str(uuid.uuid4()), "targets": targets[:], "startup": startup.get()}
            pairing_code = code.get().strip()
            def job():
                result = call(config, "pair", {"code": pairing_code, "machine": socket.gethostname(), "installationId": config["installationId"]})
                config.update(result)
                BASE.mkdir(parents=True, exist_ok=True)
                if getattr(sys, "frozen", False) and Path(sys.executable).resolve() != EXE.resolve():
                    shutil.copy2(sys.executable, EXE)
                save_config(config)
                if getattr(sys, "frozen", False): shortcuts(config)
                return config
            def done(result, error):
                if error: messagebox.showerror("Pareamento", error); return
                self.config = result; frame.destroy(); self.dashboard(); self.refresh(); self.root.after(60000, self.tick)
            self.async_action(job, done)
        ttk.Button(frame, text="Parear e criar atalhos", command=install).pack(anchor="w", pady=12)

    def dashboard(self):
        self.frame = ttk.Frame(self.root, padding=20); self.frame.pack(fill="both", expand=True)
        ttk.Label(self.frame, text="Paratech Infinite", font=("Segoe UI", 20, "bold")).pack(anchor="w")
        self.status_label = ttk.Label(self.frame, text="Consultando cobrança…", wraplength=560); self.status_label.pack(anchor="w", pady=12)
        ttk.Button(self.frame, text="Atualizar situação / pagamento", command=self.refresh).pack(anchor="w", pady=4)
        for index, target in enumerate(self.config.get("targets", [])):
            ttk.Button(self.frame, text="Abrir " + Path(target).stem, command=lambda i=index: self.request_launch(i)).pack(fill="x", pady=4)
        ttk.Label(self.frame, text="Este Hub controla apenas estes atalhos. Pode ser fechado pelo usuário.\nA comunicação ocorre a cada minuto enquanto estiver aberto.", wraplength=560).pack(anchor="w", pady=16)
        ttk.Button(self.frame, text="Remover atalhos e pareamento local", command=self.uninstall).pack(anchor="w")
        if "--background" in sys.argv: self.root.iconify()

    def uninstall(self):
        if not messagebox.askyesno("Remover", "Remover os atalhos e o pareamento deste usuário? Os programas originais permanecem intactos."):
            return
        try:
            shortcuts(self.config, remove=True); CONFIG.unlink(missing_ok=True)
            messagebox.showinfo("Removido", "Atalhos e pareamento removidos. O arquivo Paratech_Infinite.exe pode ser excluído após fechar.")
            self.close()
        except Exception as error: messagebox.showerror("Remoção", str(error))

    def accept_lease(self, token):
        lease = verify(token, self.config["publicKey"])
        if lease["hubId"] != self.config["hubId"]: raise ValueError("Autorização de outro Hub")
        self.lease = lease
        self.clock_base = timestamp(lease["serverTime"])
        self.monotonic_base = time.monotonic()
        self.config.update({"lease": token, "syncedLocal": time.time(), "maxLocal": time.time(), "counterGrant": None})
        save_config(self.config)

    def now(self):
        return self.clock_base + time.monotonic() - self.monotonic_base

    def offline(self):
        local = time.time()
        if local < self.config.get("maxLocal", local) - 300:
            raise ValueError("Relógio alterado. Conecte à internet para validar a situação.")
        self.lease = verify(self.config["lease"], self.config["publicKey"])
        self.clock_base = timestamp(self.lease["serverTime"]) + max(0, local - self.config["syncedLocal"])
        self.monotonic_base = time.monotonic()
        self.config["maxLocal"] = max(local, self.config.get("maxLocal", 0)); save_config(self.config)

    def current_status(self):
        if not self.lease: return "offline-expired"
        grant = self.config.get("counterGrant")
        if grant:
            try:
                data=verify(grant,self.config["publicKey"])
                if data["hubId"]==self.config["hubId"] and data["installationId"]==self.config["installationId"] and self.now()<timestamp(data["expiresAt"]):
                    return "released"
            except Exception: pass
        return decide(self.lease, self.now())

    def refresh(self):
        def done(result, error):
            self.last_error = error or ""
            try:
                if error and error.startswith("PAREAMENTO_RECUSADO:"):
                    self.config.pop("lease", None); self.config.pop("counterGrant", None); save_config(self.config)
                    raise ValueError("Pareamento recusado pelo portal. Contate a Paratech.")
                if error: self.offline()
                else: self.accept_lease(result["lease"])
            except Exception as exc:
                self.lease = None; self.last_error = str(exc)
            state = self.current_status()
            names = {"ok":"Em dia", "available":"Fatura disponível", "overdue":"Em atraso", "blocked":"Atalho bloqueado", "released":"Liberado", "offline-expired":"Validação online necessária"}
            self.status_label.config(text=names[state] + ("\nSem conexão: " + self.last_error if error else "\nConectado ao portal"))
            if self.launch is not None:
                if state in ("ok", "released"):
                    index, self.launch = self.launch, None
                    if self.notice: self.notice.destroy(); self.notice=None
                    self.start_target(index)
                else: self.show_notice(state)
            elif self.notice: self.show_notice(state)
        self.async_action(lambda: call(self.config,"status",{"version":VERSION,"event":"abertura pelo atalho" if self.launch is not None else ""}), done)

    def tick(self):
        if not self.stopped:
            self.refresh(); self.root.after(60000,self.tick)

    def request_launch(self, index):
        self.launch = index; self.refresh()

    def start_target(self, index):
        try:
            path = Path(self.config["targets"][index])
            if not path.is_file() or path.suffix.lower() != ".exe": raise ValueError("Programa não encontrado. Refaça o pareamento com o caminho correto.")
            subprocess.Popen([str(path)], cwd=str(path.parent), shell=False)
            if "--launch" in sys.argv: self.close()
            else: self.root.iconify()
        except Exception as error: messagebox.showerror("Abrir programa", str(error))

    def show_notice(self, status):
        if self.notice: self.notice.destroy()
        win = self.notice = tk.Toplevel(self.root)
        win.overrideredirect(True)
        width,height = 610,650
        win.geometry(f"{width}x{height}+{max(0,(win.winfo_screenwidth()-width)//2)}+{max(0,(win.winfo_screenheight()-height)//2)}")
        win.configure(bg="white", highlightbackground="#17694c", highlightthickness=2)
        # No grab, topmost loop or taskbar interference: the window stays dismissible.
        frame = tk.Frame(win,bg="white",padx=24,pady=16);frame.pack(fill="both",expand=True)
        lease=self.lease or {}; invoice=lease.get("invoice") or {}
        if lease.get("logo"):
            try:
                image=Image.open(io.BytesIO(base64.b64decode(lease["logo"].split(",")[1])));image.thumbnail((240,110))
                self.logo=ImageTk.PhotoImage(image);tk.Label(frame,image=self.logo,bg="white").pack()
            except Exception: pass
        blocked=status in ("blocked","offline-expired")
        title={"blocked":"ABERTURA PELO ATALHO BLOQUEADA","offline-expired":"CONECTE PARA VALIDAR","overdue":"FATURA EM ATRASO","available":"FATURA DISPONÍVEL","released":"ACESSO LIBERADO","ok":"EM DIA"}[status]
        color="#b42318" if blocked or status=="overdue" else "#17694c"
        heading=tk.Label(frame,text=title,font=("Segoe UI",16,"bold"),fg=color,bg="white",wraplength=550);heading.pack(pady=12)
        if status=="blocked":
            def blink():
                if win.winfo_exists():
                    heading.configure(fg="#b42318" if heading.cget("fg")=="#75180f" else "#75180f");win.after(1200,blink)
            win.after(1200,blink)
        text=f"{lease.get('customer','')}\n{lease.get('company','')}\n"
        if invoice:
            text+=f"{invoice['name']}\nFatura: {invoice['number']} · {invoice['reference']}\nVencimento: {invoice['due']}\nSaldo: R$ {invoice['balance']/100:.2f}".replace(".",",")
        else: text+=self.last_error or "Entre em contato com a Paratech."
        if status=="overdue" and lease.get("blockDate"):
            days=(datetime.fromisoformat(lease["blockDate"]).date()-datetime.fromtimestamp(self.now(),BRAZIL).date()).days
            text+=f"\nO atalho será bloqueado em {max(0,days)} dia(s)."
        tk.Label(frame,text=text,bg="white",fg=color,justify="center",font=("Segoe UI",11),wraplength=550).pack(pady=8)
        if invoice:
            ttk.Button(frame,text="CLIQUE AQUI PARA REALIZAR O PAGAMENTO",command=self.pay).pack(fill="x",pady=5)
            ttk.Button(frame,text="Enviar para meu WhatsApp",command=self.whatsapp).pack(fill="x",pady=5)
        ttk.Button(frame,text="Já paguei — atualizar",command=self.refresh).pack(fill="x",pady=5)
        if status=="blocked" and not lease.get("forced"):
            ttk.Button(frame,text="Desbloqueio em confiança — 24 horas",command=self.trust).pack(fill="x",pady=5)
        if blocked:
            ttk.Button(frame,text="Sem internet — contrassenha",command=self.counter).pack(fill="x",pady=5)
        def close_notice():
            win.destroy();self.notice=None
            if self.launch is not None and not blocked:
                current=self.current_status()
                if current in ("blocked","offline-expired"):
                    self.show_notice(current);return
                index,self.launch=self.launch,None;self.start_target(index)
            else:self.launch=None
        button=ttk.Button(frame,text="Fechar",command=close_notice);button.pack(pady=12)
        if not blocked:
            button.config(state="disabled")
            def countdown(n):
                if not win.winfo_exists():return
                button.config(text=f"Fechar e abrir programa ({n}s)" if n else "Fechar e abrir programa",state="disabled" if n else "normal")
                if n:win.after(1000,lambda:countdown(n-1))
            countdown(5)

    def pay(self):
        def done(result,error):
            if error:messagebox.showerror("Pagamento",error);return
            url=result["url"];parsed=urllib.parse.urlparse(url)
            if parsed.scheme!="https" or not (parsed.hostname or "").endswith(".infinitepay.io"):
                messagebox.showerror("Pagamento","Endereço de pagamento inesperado.");return
            webbrowser.open(url)
        self.async_action(lambda:call(self.config,"payment",{}),done)

    def whatsapp(self):
        if not messagebox.askyesno("WhatsApp","Enviar a cobrança ao WhatsApp cadastrado no portal?"):return
        request_id=str(uuid.uuid4())
        def done(result,error):
            if error:messagebox.showerror("WhatsApp",error)
            elif result.get("status")=="sent":messagebox.showinfo("WhatsApp","Envio aceito pela Uazapi.")
            else:messagebox.showwarning("WhatsApp",result.get("error") or "Envio incerto. Confira antes de repetir.")
        self.async_action(lambda:call(self.config,"whatsapp",{"requestId":request_id}),done)

    def trust(self):
        def done(result,error):
            if error:messagebox.showerror("Liberação",error);return
            self.accept_lease(result["lease"]);self.refresh()
        self.async_action(lambda:call(self.config,"trust",{}),done)

    def counter(self):
        nonce=self.config.get("challenge") or secrets.token_hex(16)
        self.config["challenge"]=nonce;save_config(self.config)
        dialog=tk.Toplevel(self.root);dialog.title("Liberação offline");dialog.geometry("620x350")
        ttk.Label(dialog,text="Envie este código à Paratech:").pack(pady=8)
        challenge=ttk.Entry(dialog);challenge.insert(0,self.config["hubId"]+":"+nonce);challenge.config(state="readonly");challenge.pack(fill="x",padx=12)
        ttk.Label(dialog,text="Cole a contrassenha recebida:").pack(pady=8)
        entry=tk.Text(dialog,height=6,wrap="char");entry.pack(fill="x",padx=12)
        def apply():
            try:
                code=entry.get("1.0","end").strip();used=self.config.get("usedChallenges",[])
                data=offline_release(code,self.config["publicKey"],self.config["hubId"],self.config["installationId"],nonce,self.now(),used)
                used.append(nonce);self.config.update({"usedChallenges":used,"challenge":None,"counterGrant":code});save_config(self.config)
                dialog.destroy()
                if self.notice:self.notice.destroy();self.notice=None
                if self.launch is not None:index,self.launch=self.launch,None;self.start_target(index)
                else:messagebox.showinfo("Liberação","Liberado até "+data["expiresAt"])
            except Exception as error:messagebox.showerror("Contrassenha",str(error))
        ttk.Button(dialog,text="Liberar",command=apply).pack(pady=12)

def main():
    if "--self-test" in sys.argv:
        # Packaging check only: no network, installation, startup or shortcuts.
        output = Path(sys.argv[sys.argv.index("--self-test") + 1])
        root = tk.Tk(); root.withdraw()
        result = {"version": VERSION, "tk": root.tk.call("info", "patchlevel"),
                  "dpapi": protect(protect(b"paratech-check"), True) == b"paratech-check",
                  "image": Image.new("RGB", (16, 16)).size == (16, 16)}
        root.destroy(); output.write_text(json.dumps(result), encoding="utf-8")
        return
    root=tk.Tk()
    try:
        launch=int(sys.argv[sys.argv.index("--launch")+1]) if "--launch" in sys.argv else None
        Hub(root,launch)
        root.mainloop()
    except Exception as error:
        messagebox.showerror("Paratech Infinite",str(error))
        root.destroy()

if __name__=="__main__":main()
